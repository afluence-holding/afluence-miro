export interface RoutePoint {
  x: number;
  y: number;
}
export interface RouteRect extends RoutePoint {
  w: number;
  h: number;
}

/** Chooses among side ports using the same geometry for design previews and live connectors. */
export function routeBetweenRectangles(
  source: RouteRect,
  target: RouteRect,
  obstacles: readonly RouteRect[],
  options: {
    sourcePort?: readonly [number, number];
    targetPort?: readonly [number, number];
    stub?: number;
    clearance?: number;
  } = {}
): RoutePoint[] | null {
  const stub = options.stub ?? 20;
  const ports = (box: RouteRect, explicit?: readonly [number, number]) => {
    const specs = explicit
      ? [explicit]
      : [
          [1, 0.5],
          [0, 0.5],
          [0.5, 1],
          [0.5, 0],
        ];
    return specs.map(([x, y]) => {
      const at = { x: box.x + box.w * x, y: box.y + box.h * y };
      const horizontal = Math.abs(x - 0.5) >= Math.abs(y - 0.5);
      const sign = (horizontal ? x : y) >= 0.5 ? 1 : -1;
      return {
        at,
        outside: {
          x: at.x + (horizontal ? stub * sign : 0),
          y: at.y + (horizontal ? 0 : stub * sign),
        },
      };
    });
  };
  const distance = (p: RoutePoint, q: RoutePoint) =>
    Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
  const pairs = ports(source, options.sourcePort)
    .flatMap(start =>
      ports(target, options.targetPort).map(end => ({
        start,
        end,
        lowerBound: distance(start.outside, end.outside) + 2 * stub,
      }))
    )
    .sort((p, q) => p.lowerBound - q.lowerBound);
  const stubClear = (at: RoutePoint, outside: RoutePoint, owner: RouteRect) =>
    obstacles.every(obstacle => {
      if (
        obstacle.x === owner.x &&
        obstacle.y === owner.y &&
        obstacle.w === owner.w &&
        obstacle.h === owner.h
      )
        return true;
      return at.y === outside.y
        ? !(
            at.y > obstacle.y &&
            at.y < obstacle.y + obstacle.h &&
            Math.max(at.x, outside.x) > obstacle.x &&
            Math.min(at.x, outside.x) < obstacle.x + obstacle.w
          )
        : !(
            at.x > obstacle.x &&
            at.x < obstacle.x + obstacle.w &&
            Math.max(at.y, outside.y) > obstacle.y &&
            Math.min(at.y, outside.y) < obstacle.y + obstacle.h
          );
    });
  let best: RoutePoint[] | null = null;
  let bestCost = Infinity;
  for (const { start, end, lowerBound } of pairs) {
    if (lowerBound >= bestCost) break;
    if (
      !stubClear(start.at, start.outside, source) ||
      !stubClear(end.at, end.outside, target)
    )
      continue;
    const middle = orthogonalRoute(start.outside, end.outside, obstacles, {
      clearance: options.clearance ?? 12,
    });
    if (!middle) continue;
    const points = [start.at, ...middle, end.at];
    const cost =
      points
        .slice(1)
        .reduce(
          (sum, point, index) => sum + distance(points[index], point),
          0
        ) +
      Math.max(0, points.length - 2) * 24;
    if (cost < bestCost) {
      best = points;
      bestCost = cost;
    }
  }
  return best;
}

/** Bounded rectilinear visibility-grid search. Coordinates are world units.
 * Returns null when obstacles or the search budget prevent a valid route;
 * callers must never present an intersecting fallback as verified routing.
 */
export function orthogonalRoute(
  start: RoutePoint,
  end: RoutePoint,
  obstacles: readonly RouteRect[],
  options: { clearance?: number; bendCost?: number; maxVisited?: number } = {}
): RoutePoint[] | null {
  if (obstacles.length > 128) return null;
  const clearance = options.clearance ?? 12;
  const boxes = obstacles.map(b => ({
    x: b.x - clearance,
    y: b.y - clearance,
    w: b.w + 2 * clearance,
    h: b.h + 2 * clearance,
  }));
  if (
    ![
      start.x,
      start.y,
      end.x,
      end.y,
      clearance,
      ...boxes.flatMap(b => [b.x, b.y, b.w, b.h]),
    ].every(Number.isFinite)
  )
    return null;
  const inside = (p: RoutePoint) =>
    boxes.some(
      b => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h
    );
  if (inside(start) || inside(end)) return null;
  const clear = (a: RoutePoint, b: RoutePoint) =>
    !boxes.some(r =>
      a.y === b.y
        ? a.y > r.y &&
          a.y < r.y + r.h &&
          Math.max(a.x, b.x) > r.x &&
          Math.min(a.x, b.x) < r.x + r.w
        : a.x > r.x &&
          a.x < r.x + r.w &&
          Math.max(a.y, b.y) > r.y &&
          Math.min(a.y, b.y) < r.y + r.h
    );
  // Most diagram edges can attain the Manhattan lower bound without building
  // the visibility grid. Collision checks still include every inflated body.
  if ((start.x === end.x || start.y === end.y) && clear(start, end))
    return [start, end];
  for (const elbow of [
    { x: end.x, y: start.y },
    { x: start.x, y: end.y },
  ]) {
    if (clear(start, elbow) && clear(elbow, end)) return [start, elbow, end];
  }
  const xs = [
    ...new Set([start.x, end.x, ...boxes.flatMap(b => [b.x, b.x + b.w])]),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set([start.y, end.y, ...boxes.flatMap(b => [b.y, b.y + b.h])]),
  ].sort((a, b) => a - b);
  const width = xs.length;
  const origin = ys.indexOf(start.y) * width + xs.indexOf(start.x);
  const destination = ys.indexOf(end.y) * width + xs.indexOf(end.x);
  const point = (id: number) => ({
    x: xs[id % width],
    y: ys[Math.floor(id / width)],
  });
  type Visit = {
    id: number;
    direction: number;
    cost: number;
    score: number;
    key: number;
  };
  const heap: Visit[] = [];
  const push = (visit: Visit) => {
    heap.push(visit);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].score <= visit.score) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = visit;
  };
  const pop = () => {
    const result = heap[0],
      last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (2 * i + 1 < heap.length) {
        let child = 2 * i + 1;
        if (
          child + 1 < heap.length &&
          heap[child + 1].score < heap[child].score
        )
          child++;
        if (heap[child].score >= last.score) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return result;
  };
  const distance = (a: RoutePoint, b: RoutePoint) =>
    Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const costs = new Map<number, number>(),
    previous = new Map<number, number>();
  costs.set(origin * 3, 0);
  push({
    id: origin,
    direction: 0,
    cost: 0,
    score: distance(start, end),
    key: origin * 3,
  });
  for (
    let visited = 0;
    heap.length && visited < (options.maxVisited ?? 20000);
    visited++
  ) {
    const current = pop();
    if (current.cost !== costs.get(current.key)) continue;
    if (current.id === destination) {
      const reversed: RoutePoint[] = [];
      let key: number | undefined = current.key;
      while (key !== undefined) {
        reversed.push(point(Math.floor(key / 3)));
        key = previous.get(key);
      }
      const path = reversed.reverse();
      return path.filter(
        (p, i) =>
          i === 0 ||
          i === path.length - 1 ||
          !(
            (path[i - 1].x === p.x && p.x === path[i + 1].x) ||
            (path[i - 1].y === p.y && p.y === path[i + 1].y)
          )
      );
    }
    const x = current.id % width,
      y = Math.floor(current.id / width),
      a = point(current.id);
    const neighbors = [
      [x - 1, y, 1],
      [x + 1, y, 1],
      [x, y - 1, 2],
      [x, y + 1, 2],
    ];
    for (const [nx, ny, direction] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= ys.length) continue;
      const id = ny * width + nx,
        b = point(id);
      if (!clear(a, b)) continue;
      const key = id * 3 + direction;
      const cost =
        current.cost +
        distance(a, b) +
        (current.direction && current.direction !== direction
          ? (options.bendCost ?? 24)
          : 0);
      if (cost >= (costs.get(key) ?? Infinity)) continue;
      costs.set(key, cost);
      previous.set(key, current.key);
      push({ id, direction, key, cost, score: cost + distance(b, end) });
    }
  }
  return null;
}
