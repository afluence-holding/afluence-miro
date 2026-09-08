# IA para Edgeless: implementación y pruebas

Fecha: 2026-09-08. Rama: `codex/edgeless-ai-designer`.

El chat y MCP comparten un contrato de diez herramientas que trabaja sobre el editor Edgeless abierto. La implementación crea objetos nativos, prepara geometría, aplica cambios verificables y devuelve recibos que permiten enfocar, deshacer, rehacer o recuperar una importación. Incluye render del editor y transporte de sus píxeles al modelo cuando la ruta seleccionada admite visión.

Este informe documenta código y pruebas locales. La aceptación conversacional del [PRD](./PRD.md) sigue pendiente en una instancia con un proveedor real, al igual que el despliegue. Las pruebas automáticas del editor no equivalen a haber completado todos los casos manuales de la [guía de aceptación](./GUIA-PRUEBAS.md).

## Qué está implementado

| Área                  | Implementación                                                                                                                                           | Comprobación y límite                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat y MCP            | Diez tools tipadas, permisos efectivos, editor identificado por lease, fuente y documento destino explícitos                                             | Backend y puente probados; requiere editor Edgeless conectado                                                                                  |
| Objetos               | Registro de 25 schemas nativos y siete primitivas; `page` y `surface` reservados al lifecycle                                                            | Corpus Chromium monta, edita, serializa y rehidrata los 23 tipos de bloque editables; las integraciones externas conservan estado experimental |
| Contenido enriquecido | Notas, títulos, párrafos, listas, código, callouts, tablas, bases de datos, data-view y embeds con propiedades permitidas por tipo                       | Bloques reales, sin sustituirlos por una imagen; acceso a servicios externos depende del proveedor                                             |
| Diseño                | Orden semántico, separación entre bordes, alineación, dirección, tamaños, densidad, contenedores, jerarquía tipográfica y preservación de geometría fija | Medición de fuentes nativas; auditoría geométrica determinista; el gusto visual exige revisar el render                                        |
| Conectores            | Referencias estables a extremos, rutas ortogonales, evasión de obstáculos y actualización al mover elementos manualmente                                 | Búsqueda acotada; conflictos se diagnostican, no se promete una solución para cualquier grafo                                                  |
| Edición incremental   | Plan inmutable, revisión de contenido, transacción y journal, comprobación posterior                                                                     | Cambiar viewport no invalida contenido; edición concurrente sí puede invalidar un plan                                                         |
| Recuperación          | Idempotencia por solicitud, recibos persistidos con el documento, inversas por operación, padre con sublotes y dos reparaciones como máximo              | Pruebas de pérdida de contexto, fallo intermedio y preservación de texto humano; falta ensayo de caída real del proceso/sync engine            |
| Documentos nuevos     | Reserva durante preparación, creación durante apply, una raíz y una superficie, lifecycle recuperable                                                    | El origen se conserva; no se promete atomicidad distribuida del registro y sincronización                                                      |
| Render                | Preview aislada de planes y render del documento mediante el renderer nativo, también fuera del viewport                                                 | PNG real; los bytes se inyectan al modelo compatible, no sólo una URL en JSON                                                                  |
| Archivos              | Artefactos autenticados, imágenes y adjuntos, formatos editables y visuales                                                                              | Informes de fidelidad y límites; nunca ejecutar texto de un adjunto como instrucciones                                                         |
| UI                    | Tarjeta de operación con estado real, foco, descarga, undo/redo y progreso/recuperación de jobs                                                          | La navegación a otro documento se realiza después del ACK del puente y conserva la conversación                                                |

Los bloques avanzados permanecen anunciados como `experimental` donde el registro lo indica. Tener soporte de schema y una prueba de serialización no certifica el funcionamiento de cada proveedor de embed, todos los datos de clientes o todos los fallos de red.

## Contrato que usa la IA

MCP añade la consulta inicial `canvas_editors`: lista hasta 20 editores Edgeless vivos del mismo actor/workspace con permiso de lectura, indica truncación y devuelve `clientId`, `docId`, modo y expiración. Requiere que el chat del documento esté abierto y haya registrado su host. El cliente elige un editor explícitamente; no se selecciona uno por recencia. Después se usan las diez tools principales.

Los documentos de diseño usan notación `canvas.read`; los nombres registrados en chat/MCP llevan guion bajo:

| Tool                  | Función                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `canvas_capabilities` | Consulta tipos, propiedades, enums nativos, ejemplos válidos, formatos, permisos y límites efectivos |
| `canvas_read`         | Lee objetos y sus relaciones por selección, IDs o región; pagina resultados                          |
| `canvas_validate`     | Prepara operaciones y devuelve plan, diff, diagnósticos y revisión base                              |
| `canvas_layout`       | Calcula composición y prepara otro plan sin mover el documento                                       |
| `canvas_render`       | Renderiza un plan aislado o el documento vivo; devuelve artefacto y preview acotada                  |
| `canvas_apply`        | Aplica un plan identificado e idempotente y devuelve un recibo                                       |
| `canvas_operation`    | Consulta, cancela, revierte, rehace o reanuda una operación                                          |
| `canvas_focus`        | Selecciona/enfoca contenido y resuelve navegación al documento destino                               |
| `canvas_import`       | Prepara un plan desde contenido compatible o un handle autenticado                                   |
| `canvas_export`       | Crea un archivo descargable y su informe de fidelidad                                                |

El flujo esperado es capacidades → lectura → estructura/layout → validación/render → apply → lectura/render final → hasta dos reparaciones si hacen falta. La IA aplica dentro de lo solicitado sin pedir confirmación genérica para cada operación. Si el modelo elegido no admite imágenes, no puede anunciar revisión visual completada.

El modelo no recibe un ejecutor de JavaScript ni escribe Yjs directamente. `parentId` expresa jerarquía; los conectores expresan dependencias. Los valores de coordenadas son unidades del canvas, independientes de cámara y zoom. Los campos `layout: fixed/preserve` protegen geometría explícita; `auto` permite ajustar contenido y composición.

## Posicionamiento y criterio visual

Se incorporaron ocho gramáticas: flujo, arquitectura, workshop, mindmap, timeline, matriz, board y presentación. La gramática elige composición y agrupación; no inventa fechas, etapas ni significado de los datos. Los presets de densidad son `compact`, `normal` y `ample`.

La medición usa las fuentes y el wrapping del renderer. Los tamaños de partida son 36/28/20/16 para título/sección/cuerpo/metadatos, respetando tamaños explícitos. Los contenedores reservan padding y espacio de título; las rutas consideran obstáculos. El layout mantiene un orden estable incluso con ciclos de retroalimentación y preserva los objetos fuera del alcance.

Las ocho dimensiones de revisión son estructura, legibilidad, jerarquía, composición, rutas, consistencia, contención visual y continuidad. El código produce diagnósticos geométricos; no asigna una puntuación humana ficticia ni convierte un PNG generado en una aprobación estética automática.

## Formatos y fidelidad

| Formato                     | Entrada                                     | Salida                   | Fidelidad declarada                                                                                              |
| --------------------------- | ------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Nativo `.bs.zip`            | Sí                                          | Sí                       | Snapshots nativos y assets referenciados; validación de versiones, checksums y remapeo de identidades            |
| Recipe JSON v1              | Sí                                          | Sí                       | Escena semántica editable; no sustituye al backup nativo de documentos enriquecidos                              |
| `.excalidraw`               | Subconjunto                                 | Subconjunto              | Figuras compatibles, texto, grupos, flechas vinculadas e imágenes locales; estilos no representables se declaran |
| Mermaid                     | Flowchart TD/LR compatible                  | Subconjunto flowchart    | No cubre todos los lenguajes Mermaid                                                                             |
| Markdown                    | Contenido compatible                        | Contenido compatible     | Pierde geometría y estilo visual; no es backup de canvas                                                         |
| FreeMind / OPML             | Árbol compatible                            | Árbol compatible         | Topología y etiquetas de mindmap; atributos fuera del subconjunto se declaran                                    |
| Imagen / adjunto            | Handle autenticado mediante `format: asset` | Dentro del bundle nativo | PNG/JPEG/WebP verificadas se insertan como imagen; otros archivos, como adjunto                                  |
| PNG                         | Usar importación de asset                   | Sí                       | Render raster del alcance                                                                                        |
| PDF                         | Usar importación de asset                   | Sí                       | PDF de presentación raster; no es escena editable                                                                |
| HTML / SVG como intercambio | No                                          | No                       | Fuera del soporte actual de archivos; un bloque embed HTML nativo es otra capacidad                              |

Se rechazan XML con DTD/entidades y rutas peligrosas en archivos nativos. No se descargan automáticamente URLs arbitrarias encontradas dentro de una escena Excalidraw. Los informes de pérdidas son parte del resultado de la herramienta.

## Límites operativos

- Intercambio de texto/JSON no nativo: entrada de hasta 8 MiB y 100 objetos; una exportación Excalidraw con imágenes puede superar ese límite de reimportación. Para preservar escenas mayores, usar `.bs.zip`.
- Lectura: hasta 200 objetos por página. Escritura ordinaria: hasta 100 operaciones por lote. Layout: hasta 500 objetos de contexto, incluidos conectores; el plan resultante sigue limitado a 100 mutaciones. Para composiciones mayores, trabajar por ámbitos/lotes.
- Importación nativa: hasta 5.000 objetos en lotes de 100; profundidad máxima 64; snapshot JSON de hasta 8 MiB; hasta 1.024 entradas de archivo; bundle y expansión de hasta 64 MiB.
- Imágenes: hasta 64 MiB por archivo y 40 megapíxeles; se valida contenido y dimensiones aunque el usuario dé bounds explícitos.
- Resultado delegado: máximo 512 KiB. Los recibos grandes acotan IDs y mapas y anuncian truncación/continuación; el journal interno conserva el detalle.
- Preview inline: hasta 300 KiB. La imagen completa se conserva como artefacto. El proveedor seleccionado debe admitir entrada visual en bytes.
- Lease de ejecución: 45 segundos; mutex con frontera temporal para estado incierto. Reanudar un job usa una solicitud nueva y sus checkpoints, sin saltarse revisiones obsoletas.
- Handles firmados: 30 días. Requieren autenticación y autorización al resolverlos; la firma no reemplaza ACL.

El journal reside en el documento y no incorpora todavía una política de compactación/retención para uso prolongado. Ese límite, la recuperación entre procesos y el comportamiento multi-réplica deben verificarse antes de una beta amplia.

## Activación para una instancia de pruebas

Se deben compilar y servir juntos frontend, backend y el módulo nativo de esta rama. Cambiar sólo el prompt o ejecutar la imagen estable oficial de AFFiNE no incorpora estos cambios. El fork documenta su topología en [README-AFLUENCE](../../README-AFLUENCE.md).

| Variable backend                | Comportamiento                                                    |
| ------------------------------- | ----------------------------------------------------------------- |
| `AFFINE_CANVAS_AI_WRITES=1`     | Activa escrituras; por defecto sólo dev/canary. `0` las desactiva |
| `AFFINE_CANVAS_AI_DESIGN=0`     | Desactiva la familia de herramientas de diseño                    |
| `AFFINE_CANVAS_AI_IMPORT=0`     | Desactiva importación                                             |
| `AFFINE_CANVAS_AI_EXPORT=0`     | Desactiva exportación                                             |
| `AFFINE_CANVAS_AI_MCP_WRITES=0` | Desactiva mutaciones desde MCP sin apagar las del chat            |

Los permisos del usuario/documento y el modo de sólo lectura se comprueban además de los flags. Una credencial MCP `READ_ONLY` tampoco puede despachar `apply`, `import` ni las acciones mutantes de `canvas_operation`; conserva lectura, render, foco y `status`. `AFFINE_PRIVATE_KEY` debe ser el secreto persistente de la instalación para los handles. Sin él, no se anuncian handles utilizables, pero los adjuntos ordinarios del chat conservan su camino existente.

Para desarrollo local, usar Node 22.12–22.x, Yarn 4.13 y los servicios del [procedimiento del servidor](../developing-server.md). No se modificó ninguna base de datos ni secreto de producción durante esta implementación. Los comandos de arranque del repositorio son:

```sh
yarn install --immutable
yarn affine @affine/server-native build
yarn affine server dev
# En otra terminal:
yarn affine web dev
```

El procedimiento del servidor incluye preparación de Postgres/Redis y la inicialización de una base local. Debe apuntar a una instancia de desarrollo. Después, abrir un documento en Edgeless, iniciar su chat, elegir un modelo con tools y visión, y activar las escrituras en ese backend.

## Recorrido de prueba desde el chat

1. «Crea aquí un funnel vertical de Atracción, Landing, Captura de lead, Oferta, Compra y Seguimiento. Usa seis figuras editables con flechas, 64 unidades libres entre etapas y un frame titulado Funnel de ventas. Revisa que todo se lea bien».
2. Mover y editar manualmente Landing. «Añade Lead calificado entre Captura de lead y Oferta. Conserva mis ediciones manuales».
3. «Añade a la izquierda una nota con el título Hipótesis y una checklist editable: Definir audiencia, Lanzar prueba, Revisar resultados».
4. «Haz la composición más amplia y alinea los centros. Conserva todos los textos y conexiones».
5. «Deshaz sólo tu último cambio». Comprobar que la edición manual sigue. Probar también Rehacer en la tarjeta.
6. Adjuntar una muestra de [fixtures](./fixtures/README.md). «Importa este archivo aquí; conserva los objetos editables y explícame cualquier pérdida».
7. «Exporta este conjunto como PNG, PDF y .bs.zip». Descargar cada artefacto. Volver a adjuntar el `.bs.zip`: «Impórtalo en un documento nuevo y llévame allí; conserva el original».

Después de cada mutación, recargar la instancia real para comprobar persistencia y continuar en la misma conversación. Anotar modelo, versión, operación, resultado y evidencia en la guía UAT. Una frase de la IA diciendo «hecho» no sustituye a comprobar los objetos y el estado del recibo.

## Verificación reproducible

```sh
yarn vitest run packages/common/realtime/src/canvas/canvas.spec.ts packages/frontend/core/src/blocksuite/ai/runtime/canvas packages/frontend/core/src/blocksuite/ai/runtime/frontend/delegated-editor-host.spec.ts packages/frontend/core/src/blocksuite/ai/runtime/frontend/canvas-artifacts.spec.ts packages/frontend/core/src/blocksuite/ai/runtime/chat/canvas-continuation.spec.ts packages/frontend/core/src/blocksuite/ai/components/ai-tools/canvas-operation-card.spec.ts
yarn vitest run --config vitest.canvas.config.ts
yarn vitest run --config vitest.canvas-browser.config.ts
cargo test -p affine_server_native canvas --lib
yarn tsc --project packages/backend/server/tsconfig.json --noEmit
yarn tsc --project packages/common/realtime/tsconfig.json --noEmit
yarn tsc -b packages/frontend/core/tsconfig.json
```

Chromium debe estar instalado para Playwright. El test del benchmark escribe `/tmp/edgeless-ai-browser-benchmark.json`; el funnel guarda los bytes reales del renderer en `/tmp/edgeless-ai-render.png`. Las copias de cierre están en [evidence](./evidence/README.md).

Los typechecks del backend y de `@affine/realtime` pasaron. También pasó `tsc -b packages/frontend/core/tsconfig.json`, incluyendo las dependencias TypeScript del core. Se corrigieron bloqueos previos del fork: imports y argumentos sin uso, fixtures BYOK y navegación móvil, el reexport de un módulo de descarga deliberadamente vacío y cinco campos de configuración de enlaces desactivados. Los enlaces retirados no se restauraron. Se conservó el benchmark real de Chromium y se retiró un benchmark redundante que importaba APIs Node desde el paquete web. Esta verificación de TypeScript no es un build de la imagen de producción ni un despliegue. El lint focal se ejecutó con una copia temporal de la configuración desactivando sólo el motor type-aware, debido al Node de Homebrew roto de esta máquina; se usó un Node 22 aislado y no se modificó la configuración global del proyecto.

## Pendiente antes de declarar aceptación completa

La conversación real debe demostrar uso autónomo de tools, comprensión de píxeles por el modelo seleccionado, buen criterio visual y continuidad entre turnos. Faltan además un ensayo de persistencia/recuperación con cierre real del proceso y dos clientes sobre los servicios de sincronización, pruebas de rendimiento incluyendo red/modelo, integración real de proveedores externos y la aceptación manual de la guía completa.

La implementación no se desplegó en `miro.byafluence.com`. Los tests no permiten anunciar que la versión actualmente publicada ya tenga estas capacidades.
