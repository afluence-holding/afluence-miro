# Verificación de producción

Fecha: 2026-09-08. Prueba mediante el chat lateral de `https://miro.byafluence.com/`, con sesión del usuario y objetos nativos de Edgeless. Las instrucciones de documentos y archivos se tratan como datos.

## Publicación

- Commit de implementación: `d93d70ea344e7ced73b42593f93a53880f1b9638`, integrado por fast-forward y publicado directamente en `main` con autorización del usuario.
- Corrección posterior del callback de tools: `399d0544bfa3ff5e458ff507c783d503c43538fd`, desplegada después de la implementación inicial.
- Corrección de lectura completa y jerarquía transaccional: `295c4bc1ab1e98f36baa7cdd82e4cbac0fdbd74f`. Deployment `055cfddd-82e4-41d7-8b78-e64cdeedc180` terminado en `SUCCESS`; versión `295c4bc1a` observada en el editor. El build reutilizó desde caché la compilación nativa de Rust.
- Hooks de commit completados: formato, lint-staged y lint global del repositorio.
- Railway: proyecto `afluence-tools`, entorno `MIRO`, servicio `Afluence Miro`.
- `AFFINE_CANVAS_AI_WRITES=1` activado en el servicio, conservando la clave privada existente. No se copiaron secretos a este informe.
- Auto-deploy observado: `c624a1ba-02eb-40a1-aa02-f65752a700f0`, origen `main` y SHA de implementación. Terminó `SUCCESS`, con instancia nueva `RUNNING`.

## Documento de prueba

[QA Canvas IA 2026-09-08](https://miro.byafluence.com/workspace/7e931664-6dad-4174-be39-6e30921486ae/XgMN_5FmR6f8qG1_jzIPx?mode=edgeless)

Documento nuevo creado por UI en el workspace sincronizado Afluence. Las pruebas de escritura se limitan a este documento y a las copias creadas para validar importación.

La repetición desde una conversación nueva usa [QA Designer E2E 2026-09-08](https://miro.byafluence.com/workspace/7e931664-6dad-4174-be39-6e30921486ae/k-UU5voOpP03mQhN41yj1?mode=edgeless). Su nota manual de control se creó con teclado y sobrevivió la recarga: «Nota manual de control: conservar este texto.»

## Resultados

| Comprobación                            | Estado                                       | Evidencia                                                                                                         |
| --------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Login y acceso al workspace real        | Verificado                                   | UI del workspace y creación del documento de QA                                                                   |
| Proveedor de IA en producción           | Verificado antes del nuevo deploy            | Chat respondió «Conexión IA lista» a una petición sin escrituras                                                  |
| Versión nueva servida                   | Verificado                                   | La implementación inicial y la corrección `399d0544bfa3ff5e458ff507c783d503c43538fd` se desplegaron en producción |
| Callback y creación nativa desde chat   | Verificado con incidencia parcial            | Tras `399d0544`, el callback funciona y el chat creó un frame, seis shapes y cinco conectores nativos             |
| Jerarquía de frame recién creado        | Corrección en curso                          | La creación anterior dejó un resultado parcial al asociar hijos a un frame creado en la misma operación           |
| Scope vacío                             | Corrección en curso                          | El validador compartido rechazó `scope: {}` aunque el schema Zod lo admite                                        |
| Geometría, conectores y composición     | Pendiente de UAT visual                      | Falta comprobar legibilidad, separación y rutas en el render real                                                 |
| Edición incremental, deshacer y rehacer | Pendiente                                    |                                                                                                                   |
| Exportación visual y nativa             | Pendiente de UAT                             | Falta descargar, abrir y comprobar PNG, PDF y `.bs.zip`                                                           |
| Importación en documento nuevo          | Pendiente de UAT                             | Falta importar el artefacto exportado y comprobar edición/persistencia                                            |
| Persistencia y sincronización           | Sincronización verificada; recarga pendiente | El funnel creado permaneció sincronizado; falta validar una recarga completa                                      |

Este archivo se actualiza con los resultados observados; un mensaje de la IA afirmando «hecho» no cuenta como validación de escritura.

## Incidencias encontradas durante la prueba

### Respuesta del host incompatible con el protocolo nativo

El primer pedido real de funnel produjo una llamada `canvas_capabilities` con el ID correcto del documento. El servidor abortó antes de devolver el resultado: `unknown field response`, con `output` entre los campos admitidos por el protocolo nativo. La UI mostró `INTERNAL_SERVER_ERROR` y el editor conservó únicamente la nota manual: cero figuras creadas y journal de operaciones vacío. Esta prueba detectó una frontera de serialización que las pruebas aisladas previas no cubrían.

Corrección: el normalizador TypeScript devuelve `callId`, `name`, `args`, `output`, `isError` y `media` en el nivel superior esperado por Rust. Verificación local: 40 pruebas del protocolo backend, typecheck del servidor y una prueba nueva del deserializador real de `runtime/backend_runtime/copilot/stream.rs`, que acepta éxito/render/error y rechaza el wrapper incorrecto. El cruce completo con N-API y el proveedor se vuelve a comprobar en producción.

También se corrigió el límite del schema de `canvas_layout` (500 objetos de contexto, conservando 100 mutaciones por lote), se aclaró el envelope de importación por handle y se acotaron las entradas Docker de Rust a los miembros/configuración de Cargo para reutilizar la compilación cuando sólo cambia TypeScript.

### Asociación de hijos a un frame nuevo

Con el callback corregido, el recorrido real creó el funnel solicitado: un frame, seis shapes y cinco conectores nativos. La persistencia se sincronizó, pero el recibo quedó parcial al asignar los hijos al frame durante la misma operación de creación. La corrección frontend está en curso y requiere un nuevo despliegue y repetición del recorrido antes de aceptar la jerarquía como verificada.

El gate Chromium equivalente ya está cerrado: el test focal del funnel comprueba un recibo `applied` y `passed`, las seis shapes, los cinco conectores y que sus `parentId` coincidan con el ID remapeado del frame. Ese resultado reduce el riesgo de regresión local, pero no sustituye la repetición en el chat de producción.

### Scope vacío aceptado por schema pero rechazado por validador compartido

La UAT descubrió que `scope: {}` pasa el schema Zod y, sin embargo, era rechazado por el validador compartido. Corregido en `295c4bc1a`: el alcance vacío representa el lienzo completo; los IDs inexistentes se rechazan con un error recuperable en vez de devolver un lienzo falsamente vacío. Los cursores inventados se rechazan sin aceptar prefijos numéricos. Pruebas: 33 de contrato/runtime y 41 de backend, más typechecks de core y servidor.

### Normalización remota de campos opcionales

Una conversación nueva en `295c4bc1a` seguía enviando todos los campos opcionales, incluso `cursor` y `scope.ids` ficticios, pese a las descripciones explícitas. Las llamadas reales y sus errores se conservaron en `/tmp/edgeless-production-designer-tools.json`. La prueba se detuvo sin aplicar cambios.

El schema emitido localmente conserva correctamente los campos opcionales. La [documentación oficial de function calling](https://developers.openai.com/api/docs/guides/function-calling?api-mode=responses) explica una segunda frontera: Responses normaliza el schema a modo estricto cuando se omite `strict`. Hay que enviar `strict: false` explícitamente para conservar la semántica opcional del contrato, manteniendo la validación local y los permisos de cada operación. Esta corrección de transporte y su repetición en producción siguen pendientes de aceptación.

La corrección del cliente HTTP se prueba en la frontera final de `post_json` y `post_sse`, usando también el encoder real de Responses: conserva los schemas, las configuraciones explícitas y los headers/timeout/egress. Cuatro pruebas nuevas del cliente y cuatro del stream nativo (callback y entrega visual según la ruta elegida) pasan.

### Descargas autenticadas y defecto visual del segundo render

El chat exportó la nota de control mediante `canvas_export`; se descargaron los tres archivos con la sesión real y cada SHA-256 coincidió con el devuelto por la herramienta. El documento conservó exactamente sus cuatro bloques y la nota original, sin recibos de escritura.

| Formato | Archivo local                          | Tamaño       | Comprobación                                                                   |
| ------- | -------------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| PNG     | `/tmp/edgeless-production-note.png`    | 24.298 bytes | Imagen 598 × 344; título y texto correctos                                     |
| PDF     | `/tmp/edgeless-production-note.pdf`    | 17.567 bytes | PDF 1.7 válido de una página; revisión visual detectó áreas grises incorrectas |
| Nativo  | `/tmp/edgeless-production-note.bs.zip` | 859 bytes    | ZIP válido con snapshot y manifest; conserva note/paragraph y su texto         |

La imagen RGB incrustada en el PDF contiene las zonas grises. Re-embebiendo el PNG correcto con la misma librería en Node, el PDF se ve correcto. Un segundo PNG de producción fue byte a byte idéntico al primero y un segundo PDF, con la librería ya cargada, se vio correcto. Que un PDF sea parseable no basta para aprobar su fidelidad visual.

La corrección captura píxeles y dimensiones en un canvas privado antes de cualquier espera de la exportación PDF. La regresión Chromium comprueba colores y tamaño de página incluso si el caller repinta y redimensiona el canvas original mientras termina la exportación. También se limitó el CSS de `CanvasOperationCard` a su propio elemento: al ser un componente sin shadow DOM, sus selectores anteriores de imágenes/botones podían afectar al editor. Gates: PDF Chromium 1/1, card 6/6 y typecheck core. La fidelidad del primer PDF después de recargar producción se debe repetir para confirmar el recorrido completo.

## Gates pendientes

La aceptación de producción sigue abierta. Tras desplegar las dos correcciones en curso, hay que repetir la creación del funnel y completar UAT visual, edición incremental/undo/redo, exportación PNG/PDF/`.bs.zip`, reimportación en documento nuevo y recarga del documento. El resultado debe comprobar los objetos y recibos reales; una respuesta afirmativa del modelo no es evidencia suficiente.
