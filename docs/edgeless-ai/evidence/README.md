# Evidencia de la implementación

El [registro de verificación](./verification.json) incluye la revisión base y un hash de los archivos de código modificados.

Ejecutado localmente el 2026-09-08 en `codex/edgeless-ai-designer`. Estas evidencias corresponden al código de la rama, no a la instancia publicada ni a una conversación con un proveedor real.

| Comprobación                                           | Resultado                                                                          | Evidencia                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Contrato y unidades/integración frontend               | 13 archivos, 75 tests pasan                                                        | [Salida Vitest](./unit-tests.log)                                                                                                        |
| Runtime tras corrección final de proyección pública    | 8 archivos, 47 tests pasan (subconjunto de los anteriores; no se suman)            | Comando `vitest run packages/frontend/core/src/blocksuite/ai/runtime/canvas`; salida terminal, 5,22 s                                    |
| Backend, permisos, handles, flags y descubrimiento MCP | 4 archivos, 37 tests pasan                                                         | [Salida Vitest](./backend-tests.log)                                                                                                     |
| Chromium real                                          | 5 archivos, 10 tests pasan, 19,93 s                                                | Comando `vitest run --config vitest.canvas-browser.config.ts --reporter verbose`; resultado observado en terminal del agente de frontend |
| Rust: selección de modelo/visión, handles e indexación | 4 tests pasan                                                                      | [Salida Cargo](./rust-tests.log)                                                                                                         |
| TypeScript                                             | Backend, realtime y `tsc -b frontend/core` pasan, incluyendo dependencias del core | [Salida final de TypeScript](./frontend-typecheck-final.log) (sin errores)                                                               |
| Fixtures previos corregidos                            | BYOK y navegación móvil: 16/16 tests pasan                                         | Comprobación focal del agente de frontend                                                                                                |
| Dependencias                                           | `yarn install --immutable --mode=skip-build` pasa, con avisos existentes de peers  | No se ejecutaron scripts de instalación ni migraciones                                                                                   |

La prueba Chromium usa modelos, APIs de editor, fuentes, DOM y render nativos. Los servicios externos, el almacenamiento remoto de artefactos y la entidad de workspace completa se sustituyen por adaptadores de prueba cuando hace falta. No demuestra entrega por WebSocket real, persistencia contra Postgres ni reconocimiento visual de un modelo remoto.

## Qué cubre Chromium

- Funnel: crear, medir texto, layout y rutas, conservar edición manual, renderizar bytes PNG, exportar PDF y roundtrip nativo, revertir.
- Jerarquía note → paragraph → list: creación, edición, revert y redo a través de tools.
- Excalidraw: conversión aislada, imágenes agrupadas, flechas vinculadas a imágenes, exportación y reimportación a través de handles simulados.
- Imágenes: bytes reales y conservación de assets; rechazo de PNG truncado y de más de 40 MP; exportación Base64 con una prueba unitaria adicional de PNG de 256 KiB.
- Registro completo: 25 schemas, 23 tipos de bloque editables; montaje nativo, edición, snapshot y rehidratación.
- Importación de 220 objetos: interrupción tras un lote de 100, runtime recreado sobre el documento, reanudación sin duplicados y revert que preserva cambios humanos; rechazo por revisión obsoleta.
- Documento nuevo: factory de producción adaptada a TestWorkspace, una raíz/superficie, jerarquía y PNG conservados, retry de la misma operación y revert en el destino sin cambiar contenido del origen.

## Render producido por el editor

[funnel-native-render.png](./funnel-native-render.png) contiene los bytes entregados por el renderer nativo, no una captura del DOM ni una imagen generada por un modelo. «Captura manual» es la edición humana deliberada del fixture. La imagen tiene transparencia y puede verse oscura sobre un visor con fondo oscuro.

![Funnel con edición manual conservada](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/docs/edgeless-ai/evidence/funnel-native-render.png)

## Medición de rendimiento

[Datos completos de 30 iteraciones](./chromium-benchmark.json). Chromium 145, 14 CPUs lógicas. Se midieron escenas sintéticas en el editor local ya inicializado:

| Operación medida                                                             |      p50 |      p95 |
| ---------------------------------------------------------------------------- | -------: | -------: |
| Layout + medición tipográfica nativa + routing de 100 nodos y 150 conectores | 127.1 ms | 143.8 ms |
| Apply nativo de 100 shapes, incluido preflight de fuentes                    |  16.8 ms |  19.5 ms |

No incluye generación del modelo, red, guardado remoto ni una sesión fría de arranque. No es una promesa universal de latencia ni verifica el objetivo end-to-end del PRD.

## Límites de la evidencia

La aceptación manual de gusto visual, conversación multi-turno, recarga contra el servicio de sincronización real, cierre del proceso, dos clientes, proveedores de embeds y MCP externo permanece pendiente. El archivo [frontend-typecheck-before-prerequisite-fixes.log](./frontend-typecheck-before-prerequisite-fixes.log) conserva los errores previos encontrados fuera del canvas; fueron corregidos y el chequeo TypeScript final con dependencias pasó. La imagen de producción no se construyó ni desplegó.
