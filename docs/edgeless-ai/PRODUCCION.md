# Verificación de producción

Fecha: 2026-09-08. Prueba mediante el chat lateral de `https://miro.byafluence.com/`, con sesión del usuario y objetos nativos de Edgeless. Las instrucciones de documentos y archivos se tratan como datos.

## Publicación

- Commit de implementación: `d93d70ea344e7ced73b42593f93a53880f1b9638`, integrado por fast-forward y publicado directamente en `main` con autorización del usuario.
- Hooks de commit completados: formato, lint-staged y lint global del repositorio.
- Railway: proyecto `afluence-tools`, entorno `MIRO`, servicio `Afluence Miro`.
- `AFFINE_CANVAS_AI_WRITES=1` activado en el servicio, conservando la clave privada existente. No se copiaron secretos a este informe.
- Auto-deploy observado: `c624a1ba-02eb-40a1-aa02-f65752a700f0`, origen `main` y SHA de implementación. Terminó `SUCCESS`, con instancia nueva `RUNNING`.

## Documento de prueba

[QA Canvas IA 2026-09-08](https://miro.byafluence.com/workspace/7e931664-6dad-4174-be39-6e30921486ae/XgMN_5FmR6f8qG1_jzIPx?mode=edgeless)

Documento nuevo creado por UI en el workspace sincronizado Afluence. Las pruebas de escritura se limitan a este documento y a las copias creadas para validar importación.

## Resultados

| Comprobación                            | Estado                             | Evidencia                                                                                    |
| --------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Login y acceso al workspace real        | Verificado                         | UI del workspace y creación del documento de QA                                              |
| Proveedor de IA en producción           | Verificado antes del nuevo deploy  | Chat respondió «Conexión IA lista» a una petición sin escrituras                             |
| Versión nueva servida                   | Verificado                         | `#app[data-version] = d93d70ea3` después de navegar de nuevo al documento                    |
| Creación nativa desde chat              | Fallo inicial; corrección en curso | El modelo invocó `canvas_capabilities`, pero el protocolo nativo rechazó el campo `response` |
| Geometría, conectores y composición     | Pendiente                          |                                                                                              |
| Edición incremental, deshacer y rehacer | Pendiente                          |                                                                                              |
| Exportación visual y nativa             | Pendiente                          |                                                                                              |
| Importación en documento nuevo          | Pendiente                          |                                                                                              |
| Persistencia tras recarga               | Pendiente                          |                                                                                              |

Este archivo se actualiza con los resultados observados; un mensaje de la IA afirmando «hecho» no cuenta como validación de escritura.

## Incidencias encontradas durante la prueba

### Respuesta del host incompatible con el protocolo nativo

El primer pedido real de funnel produjo una llamada `canvas_capabilities` con el ID correcto del documento. El servidor abortó antes de devolver el resultado: `unknown field response`, con `output` entre los campos admitidos por el protocolo nativo. La UI mostró `INTERNAL_SERVER_ERROR` y el editor conservó únicamente la nota manual: cero figuras creadas y journal de operaciones vacío. Esta prueba detectó una frontera de serialización que las pruebas aisladas previas no cubrían.

Corrección: el normalizador TypeScript devuelve `callId`, `name`, `args`, `output`, `isError` y `media` en el nivel superior esperado por Rust. Verificación local: 40 pruebas del protocolo backend, typecheck del servidor y una prueba nueva del deserializador real de `runtime/backend_runtime/copilot/stream.rs`, que acepta éxito/render/error y rechaza el wrapper incorrecto. El cruce completo con N-API y el proveedor se vuelve a comprobar en producción.

También se corrigió el límite del schema de `canvas_layout` (500 objetos de contexto, conservando 100 mutaciones por lote), se aclaró el envelope de importación por handle y se acotaron las entradas Docker de Rust a los miembros/configuración de Cargo para reutilizar la compilación cuando sólo cambia TypeScript.
