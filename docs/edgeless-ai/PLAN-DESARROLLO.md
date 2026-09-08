**Plan de desarrollo: IA diseñadora de Edgeless**

Estado del desarrollo: consultar [implementación, evidencias y activación](./IMPLEMENTACION.md). Este documento conserva la especificación de diseño; no certifica por sí mismo una prueba ni un despliegue.

Este documento descompone el desarrollo en incrementos revisables. `PRD.md` es la especificación normativa; si aparece una diferencia, se resuelve a favor del PRD antes de implementar. Los nombres de módulos nuevos son propuestas. Ninguna capacidad descrita como futura se considera implementada ni desplegada.

El resultado completo es una IA que entiende el lienzo, diseña composiciones legibles, crea y modifica elementos nativos, verifica el resultado y conversa sobre cambios sucesivos. La primera demostración de formas y conectores constituye un hito, no la entrega total. El objetivo final cubre todos los tipos editables del manifiesto activo: el inventario inicial identificado contiene 25 schemas de `AffineSchemas` y 7 primitivas; los bloques estructurales `page` y `surface` se gestionan mediante el ciclo de vida documental.

**Decisiones de implementación**

- Ejecutar primero sobre el editor vivo, usando sus APIs, sincronización y renderizado. El mismo contrato se expondrá mediante MCP. La ejecución sin editor abierto se evaluará como capacidad posterior y explícita.
- Mantener un contrato versionado compartido para chat, executor, importación y MCP. El modelo describe operaciones semánticas; nunca escribe Yjs bruto ni ejecuta JavaScript arbitrario.
- Resolver geometría y restricciones mediante código determinista. El modelo decide estructura, jerarquía y dirección visual; la medición tipográfica y el motor de layout calculan las coordenadas finales.
- Preparar y validar fuera del documento; aplicar lotes acotados. Cada `taskId` tiene un `parentOperationId`; los sublotes y las reparaciones son hijos ordenados con recibos propios. Deshacer apunta a la operación padre salvo que se solicite un hijo concreto.
- Conservar el máximo existente de 20 pasos de herramientas. Permitir como máximo dos pasadas correctivas automáticas por tarea; al agotarlas, presentar el estado real y las incidencias pendientes.
- Separar ejecución, verificación y persistencia. Persistencia usa `memory`, `local_durable`, `sync_pending` o `synced`; `applied` describe ejecución. Aceptar un trabajo o recibir un ACK de transporte no significa que el documento esté guardado.
- No anunciar atomicidad, exactamente una ejecución, deshacer selectivo o fidelidad total de exportación hasta que sus pruebas específicas demuestren esas propiedades.

**Base de código y restricciones verificadas**

| Área                     | Integración y consecuencia                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registro de herramientas | [ToolRuntime:98](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/backend/server/src/plugins/copilot/runtime/tool-runtime.ts:98), [PromptToolsSchema:76](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/backend/server/src/plugins/copilot/providers/types.ts:76) y [prompt de chat:726](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/backend/native/src/llm/assets/prompts/built-in.json:726). Añadir capacidades exige actualizar las tres superficies y sus contratos. Las escrituras documentales actuales siguen limitadas a dev/canary.                                                                  |
| Bucle del modelo         | [capability-runtime.ts:218](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/backend/server/src/plugins/copilot/runtime/capability-runtime.ts:218). Devuelve resultados al modelo; `maxSteps` es 20 en la línea 229.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Puente al editor         | [chat.tsx:166](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/frontend/core/src/desktop/pages/workspace/detail-page/tabs/chat.tsx:166), [DelegatedEditorHost:254](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/frontend/core/src/blocksuite/ai/runtime/frontend/delegated-editor-host.ts:254), [DelegatedEditorService:103](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/backend/server/src/plugins/copilot/delegated/service.ts:103). El protocolo actual es de lectura y rechaza cambios de estado durante la llamada: no se puede añadir un write al switch sin cambiar ese protocolo.                  |
| Contrato realtime        | [tipos compartidos:339](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/common/realtime/src/index.ts:339), [validación backend:53](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/backend/server/src/plugins/copilot/delegated/realtime.ts:53). Actualmente enumera cuatro lecturas; los resultados tienen límite de 512 KiB.                                                                                                                                                                                                                                                                                                   |
| Estado y lecturas        | [live-projection.ts:120](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/frontend/core/src/blocksuite/ai/runtime/frontend/live-projection.ts:120), [doc-canvas-read.ts:279](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/backend/server/src/plugins/copilot/tools/doc-canvas-read.ts:279). Son proyecciones acotadas; no son un formato de exportación sin pérdidas.                                                                                                                                                                                                                                                          |
| Mutación                 | [edgeless-response.ts:241](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/frontend/core/src/blocksuite/ai/actions/edgeless-response.ts:241) demuestra inserción nativa. [EdgelessCRUD:39](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/blocks/surface/src/extensions/crud-extension.ts:39) incluye conectores al borrar; `addElement` aplica preferencias de la última herramienta y `updateElement` las recuerda. El executor debe controlar estos efectos.                                                                                                                                                        |
| Transacciones y undo     | [Store.transact:371](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/framework/store/src/model/store/store.ts:371) captura excepciones y las registra; no implementa rollback. [captureSync:423](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/framework/store/src/model/store/store.ts:423) separa capturas; [HistoryExtension:22](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/framework/store/src/extension/history/history-extension.ts:22) rastrea el origen del cliente.                                                                                                                         |
| Guardado                 | [Doc.waitForSyncReady:130](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/frontend/core/src/modules/doc/entities/doc.ts:130) espera carga, no confirmación de esta escritura. [DocFrontend.waitForSynced:519](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/common/nbstore/src/frontend/doc.ts:519) espera actualizaciones locales y sincronización; hay que vincular el resultado a la operación concreta.                                                                                                                                                                                                                   |
| Layout y render          | [auto-align.ts:24](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/blocks/surface/src/commands/auto-align.ts:24) organiza por filas de cuatro y separación fija; no sustituye un layout semántico. [fitContent:232](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/gfx/shape/src/element-renderer/shape/utils.ts:232) mide texto con DOM. [ExportManager:369](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/blocks/surface/src/extensions/export-manager/export-manager.ts:369) produce canvas con bloques y primitivas, pero exige `CanvasRenderer` y componentes DOM disponibles. |
| MCP                      | [provider.ts:203](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/backend/server/src/plugins/copilot/mcp/provider.ts:203) registra lectura y escrituras Markdown condicionadas; [controller.ts:205](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/packages/backend/server/src/plugins/copilot/mcp/controller.ts:205) ya implementa listado y llamada de herramientas.                                                                                                                                                                                                                                                                   |

**Contrato propuesto**

**Identidades y versiones**

Toda operación lleva versión de contrato, `workspaceId`, `taskId` y alcance explícito. `canvas.validate` y `canvas.import` reciben destino `existing` o `new_document`: el primero vincula un `docId` existente; el segundo reserva un `docId` dentro del plan sin crear un documento visible hasta `canvas.apply`. El plan y todos sus recibos conservan ese destino. El backend obtiene el actor de la autenticación, nunca de los argumentos del modelo. La preparación de planes es interna: el chat aplica automáticamente dentro del alcance pedido y no añade una confirmación obligatoria al usuario. Separar:

- `editorInstanceId`: la instancia que ejecutará el trabajo.
- `contentRevision`: token opaco de contenido; un state vector CRDT no se trata como contador escalar.
- `viewContextId`: selección, zoom y viewport.
- `parentOperationId`: identidad del cambio lógico solicitado por `taskId`, con hijos ordenados para sublotes y reparaciones.
- `operationId` y `requestId`: identidad estable de cada operación padre/hija y deduplicación de sus reintentos.
- `planId` y `planDigest`: plan preparado inmutable; cualquier cambio de contenido, layout o assets produce otra versión.

Las precondiciones incluyen el contenido leído y los elementos afectados. El primer executor puede exigir revisión completa; uno posterior podrá aceptar cambios ajenos al área cuando demuestre que sus dependencias siguen válidas. Nunca refrescar silenciosamente la revisión para forzar un plan obsoleto.

**Herramientas principales**

| Herramienta           | Entrada                                                                                                      | Salida y efectos                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas.capabilities` | Contexto y familias opcionales                                                                               | Manifiesto de tipos, operaciones, propiedades, formatos, renderer, límites y permisos efectivos. No modifica.                                                                                                                                             |
| `canvas.read`         | Overview, frame, región, IDs o selección; detalle solicitado                                                 | Nodos, estructura, estilos pertinentes, relaciones, bounds, revisión y truncación. Ampliar o envolver las lecturas actuales.                                                                                                                              |
| `canvas.validate`     | Escena u operaciones tipadas, destino `existing`/`new_document`, alcance, assets por handle y precondiciones | `planId`, digest, destino/reserva de ID, diff, diagnósticos por ID/ruta, referencias, cascadas y límites. No modifica documentos ni crea uno visible.                                                                                                     |
| `canvas.layout`       | Plan o alcance leído; algoritmo, anclas, restricciones y tokens visuales                                     | Nuevo plan y métricas de composición. Nunca modifica el documento; la aplicación corresponde a `canvas.apply`. Respeta elementos fijados, grupos, dirección de lectura y área autorizada.                                                                 |
| `canvas.render`       | Fuente `prepared_plan` o `live`; región/frame/IDs, revisión y calidad acotada                                | Handle de imagen, tamaño, revisión, bounds y diagnósticos de render. No dispara descargas ni altera selección o documento.                                                                                                                                |
| `canvas.apply`        | `planId`, `requestId`                                                                                        | Recibo o job; el plan vincula digest, destino y alcance. Solo aplica el plan validado y revalida permisos, contexto y precondiciones inmediatamente antes del commit.                                                                                     |
| `canvas.operation`    | `operationId` padre o hijo explícito; `action`: `status`, `cancel`, `revert` o `redo`                        | Estado durable agregado o del hijo. Revertir prepara/aplica una inversa mediante el mismo executor; redo vuelve a validar autorización, alcance y precondiciones. No se reproduce una escritura obsoleta ni se llama a la pila global sin comprobaciones. |
| `canvas.focus`        | Operación, IDs, frame o bounds dentro del documento autorizado                                               | Enfoca la vista del usuario. No modifica contenido ni revisión documental.                                                                                                                                                                                |
| `canvas.import`       | Handle, formato/versiones, destino `existing`/`new_document`, colocación y fidelidad                         | Prepara un plan y sus assets; puede reservar `docId`, pero no modifica documentos ni crea uno visible. Devuelve pérdidas y dependencias.                                                                                                                  |
| `canvas.export`       | Alcance, formato/versiones, fidelidad y assets                                                               | Crea un artefacto descargable y reporte de fidelidad; no devuelve blobs enormes en el contexto.                                                                                                                                                           |

El vocabulario de operaciones incluye crear bloque/primitiva, editar texto y propiedades permitidas, mover, redimensionar, conectar, agrupar/desagrupar, reordenar, modificar jerarquía y eliminar. No todos los tipos admiten todas las operaciones. Un registry por tipo implementa validación, dependencias, medición, aplicación, proyección, snapshot e inversa. IDs simbólicos dentro del lote permiten crear nodos y conectarlos en una sola llamada.

El recibo común incluye estado, IDs creados/modificados/eliminados, mapa de IDs simbólicos, revisión anterior/posterior, diff verificado, bounds resultantes, advertencias, persistencia, recuperación disponible y referencias de artefactos. Errores públicos canónicos: `INVALID_PLAN`, `UNSUPPORTED_CAPABILITY`, `AMBIGUOUS_TARGET`, `PERMISSION_DENIED`, `ELEMENT_LOCKED`, `STALE_PLAN`, `EDITOR_UNAVAILABLE`, `CONSTRAINT_CONFLICT`, `ASSET_MISSING`, `FONT_UNAVAILABLE`, `FORMAT_LOSS`, `PARTIAL_APPLICATION`, `SYNC_PENDING`, `OPERATION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `RENDER_UNAVAILABLE` y `BUDGET_EXCEEDED`. Los errores internos se mapean a este catálogo; no se publican sinónimos alternativos. No presentar como fallo inocuo una operación cuya aplicación sea incierta.

**Journal, jobs y recuperación**

El servidor reserva una operación única por actor/workspace/documento/`requestId` y guarda su digest. Repetir la misma solicitud devuelve el recibo existente; reutilizar `requestId` con otro digest devuelve conflicto. El cliente verifica una autorización acotada al editor y documento, consulta su recibo durable y ejecuta un solo commit por operación. La recuperación debe poder demostrar si el commit ocurrió aunque se pierda el ACK, se cierre la pestaña o cambie el proceso backend.

Estado público de ejecución: `preparing`, `ready`, `applying`, `applied`, `cancelled`, `failed`, `partial`, `conflict` o `reverted`. Persistencia independiente: `memory`, `local_durable`, `sync_pending` o `synced`; verificación registra pendiente, aprobada o fallida conforme al contrato. No se usa `completed` como sustituto de esas dimensiones. Un `canvas.render` fallido después del guardado no cambia el hecho de que el contenido fue sincronizado.

Estados internos pueden incluir `dispatching`, `waiting_for_editor`, `awaiting_sync`, `reconciling` y `cancel_requested`, pero se mapean al recibo público: por ejemplo, esperando editor conserva ejecución `ready` con diagnóstico `EDITOR_UNAVAILABLE`; esperando sincronización conserva `applied` y `sync_pending`; aplicación incierta se presenta como `partial` con diagnóstico verificable, nunca como `failed` sin cambios. Cancelación pendiente no se presenta como cancelada antes de comprobar sus efectos. El mapeo y el esquema se generan desde el catálogo común de PR-01.

El mecanismo para asociar un marcador de operación al mismo cambio CRDT o a una frontera durable equivalente es un spike bloqueante. Un Map en memoria o una fila backend marcada antes de recibir el cambio no basta. El ledger debe sobrevivir a reinicios y poder reconciliar con el documento. La ventana de retención y la política de limpieza se fijan antes de beta; un recibo expirado no autoriza a reejecutar a ciegas.

Las mutaciones se preparan completamente antes del commit: assets resueltos, referencias válidas, tipos admitidos, tamaños finitos y cascadas calculadas. La transacción Yjs agrupa cambios, pero no deshace excepciones. Se exige postverificación y recuperación probada de fallos inyectados. No publicar un indicador `atomic: true` basándose solo en `transact`.

Undo inmediato puede aprovechar capturas separadas con metadatos de operación. Deshacer una acción anterior tras edición humana requiere una inversa por operación que preserve cambios concurrentes. Si no puede revertir sin afectar ediciones ajenas, devuelve conflictos y ofrece el subconjunto recuperable de forma explícita. No sustituye el documento completo por un snapshot anterior. La reversión se registra como nueva operación y también se sincroniza. La operación padre reúne todos sus hijos aplicados, incluidas hasta dos reparaciones, y calcula inversas en orden inverso de dependencias; identifica explícitamente cualquier hijo que no pueda revertir. Redo genera otro plan/recibo idempotente y comprueba de nuevo autorización, revisiones, assets y alcance; no reutiliza precondiciones caducadas.

Para `new_document`, `canvas.apply` provisiona el destino mediante el lifecycle existente: registro en workspace, inicialización y contenido. El journal conserva las fases y el `docId` reservado para recuperar fallos entre ellas sin duplicar documentos. Preparar no crea contenido visible; una vez iniciado apply, un crash puede dejar un documento visible parcial identificado y recuperable. Ese caso se informa y reconcilia: no se promete atomicidad distribuida. El documento de origen se conserva y solo se modifica si el usuario pidió una operación separada sobre él.

**Secuencia de PRs**

Esfuerzo relativo: S = acotado, M = varias integraciones, L = subsistema con pruebas de extremo a extremo. No son fechas ni estimaciones de días. Dividir un PR L si su diff deja de ser revisable, manteniendo su criterio de aceptación.

**PR-00 — Spikes bloqueantes y matriz de capacidades · M**

**Depende de:** PRD acordado. **Entradas:** checkout y corpus de documentos de prueba. **Salidas:** decisiones arquitectónicas, matriz exacta de cobertura y límites iniciales basados en medidas.

- Probar commit marcador/recibo + persistencia + pérdida de ACK; identificar la frontera durable observable. Incluir creación de destino nuevo con fallo entre registro, inicialización y contenido, admitiendo documento parcial identificado recuperable como alternativa a atomicidad distribuida.
- Probar fallo en el paso intermedio de un lote, undo inmediato, reversión del padre con sublotes/repairs, redo y cambios locales/remotos intercalados.
- Verificar invalidación de revisiones para primitivas, bloques, texto, assets y relaciones; separar eventos de viewport.
- Comprobar render de primitivas y bloques fuera del viewport bajo renderers activos, fuentes y assets. Demostrar que la imagen llega al modelo como entrada visual; devolver una URL en JSON no demuestra visión.
- Medir límites de lotes, importaciones, memoria de render y tiempo en el hilo UI con escenas pequeñas, mixtas y grandes. Elegir motor de layout de grafos mediante casos reales, no por una dependencia asumida.

**Aceptación:** cada spike documenta prueba, decisión, límite y fallback. Si falla persistencia/recuperación/undo, continuar en preparación y preview sin escritura beta. Si falla visión, puede existir una demo geométrica, pero no se declara terminado el diseñador con revisión visual. Si falla headless, MCP exige editor vivo.

**Release/rollback:** no activa escrituras ni cambia datos de usuario.

**PR-01 — Contrato compartido y registry por tipo · M**

**Depende de:** PR-00. **Entradas:** matriz y decisiones. **Salidas:** schemas versionados, errores, límites, manifiesto y fixtures; ubicarlos en un paquete compartido sin dependencia del DOM.

Separar schemas nativos, elementos visuales y operaciones. Declarar padres válidos, props editables, bloqueo, assets, compatibilidad de importación y capacidades por renderer. Mantener schemas JSON precomputados para tools. Los tipos desconocidos pueden conservarse en exportación nativa si el formato lo permite; no se editan mediante props arbitrarias.

**Pruebas/aceptación:** cada tipo del manifiesto tiene estado explícito; inputs malformados, coordenadas no finitas, referencias rotas, jerarquías inválidas y versiones incompatibles fallan sin tocar el documento. Snapshot de contrato y paridad de schemas entre frontend/backend; generar un único catálogo de errores públicos, ejecución y persistencia con mapeo explícito de estados internos.

**Release/rollback:** contrato y discovery bajo flag; compatibilidad aditiva. Retirar una capacidad del anuncio no migra ni elimina bloques.

**PR-02 — Lectura completa para diseño y render verificable · M**

**Depende de:** PR-01 y spike visual. **Entradas:** proyecciones actuales. **Salidas:** lecturas por nivel de detalle, revisionado de contenido y `canvas.render` como artefacto autenticado.

Leer los estilos que el agente necesita para continuar una composición. Renderizar regiones y planes preparados sin desplazar la vista del usuario. Acotar píxeles y assets; las escenas grandes se renderizan por regiones. Integrar la imagen en la siguiente iteración del modelo por la ruta multimodal comprobada en PR-00.

**Pruebas/aceptación:** la misma revisión produce geometría consistente entre lectura e imagen; cambios de selección no invalidan contenido; ningún elemento invisible se reporta como visualmente comprobado. Fuentes pendientes, renderer no admitido y assets faltantes producen diagnósticos. El modelo identifica un defecto visual sembrado que no aparece descrito en el JSON.

**Release/rollback:** flag de lectura/render independiente; desactivarlo conserva herramientas actuales y artefactos ya generados según retención.

**PR-03 — Preparador y executor nativo de lotes · L**

**Depende de:** PR-01. **Entradas:** plan tipado. **Salidas:** `canvas.validate`, planes inmutables y executor interno para formas, texto, notas, frames, grupos y conectores; todavía sin acceso de usuarios beta.

Resolver IDs y orden de creación, capas y padres. Preservar estilos explícitos del plan sin contaminación de preferencias de la última herramienta. Calcular cascadas de borrado; mantener nodos y conectores consistentes. Medir y preparar fuera del documento. Provisionar `new_document` mediante el lifecycle existente solo durante apply, usando el `docId` reservado por el plan y conservando el documento de origen. Verificar el diff real después de aplicar.

**Pruebas/aceptación:** crear un flujo completo en un lote, editar solo los IDs solicitados y rechazar referencias obsoletas. Fallos en cualquier fase no terminan comunicados como éxito; probar la recuperación definida en PR-00. Ningún lote parcialmente aplicado queda sin recibo y ruta de recuperación.

**Release/rollback:** solo fixtures/entornos internos hasta PR-04. El rollback desactiva ejecución, no borra lo ya creado.

**PR-04 — Journal durable, permisos, ACK, jobs y undo · L · gate de escritura**

**Depende de:** PR-00 y PR-03. **Entradas:** executor y decisiones de durabilidad. **Salidas:** protocolo de mutación completo, ledger, reconciliación, aislamiento de editor y operación inversa.

Actualizar tipos realtime, validación backend, selección del lease, respuestas y disponibilidad de capabilities. Comprobar `Doc.Update` para destino existente y `Workspace.CreateDoc` para destino nuevo, además de readonly/bloqueos/contexto en frontend justo antes de aplicar. Registrar fases de reserva, registro, inicialización y contenido del documento nuevo, sin duplicar raíces ni publicar un falso éxito ante creación parcial. El backend acepta la revisión posterior legítima de una escritura en vez de exigir que siga siendo igual a la anterior. Correlacionar ACK con operación/digest/diff y confirmación de sincronización. Resolver trabajos tras reconexión sin repetir commits inciertos.

**Pruebas/aceptación obligatorias:** solicitudes duplicadas; mismo `requestId` con otro payload; ACK perdido después de aplicar; reinicio frontend/backend; dos clientes del mismo usuario; cambio de documento; permiso revocado; readonly; timeout; cancelación antes/durante/después del commit; edición concurrente de un nodo; un padre con tres sublotes y dos reparaciones, undo seguido de redo y reversión sin borrar cambios humanos; fallos entre registro de documento nuevo, inicialización y contenido con recuperación al mismo `docId` y conservación del documento de origen. Recargar desde persistencia y observar el mismo cambio. El test no puede usar `waitForSyncReady` como prueba de guardado.

**Release/rollback:** escritura beta permanece apagada hasta pasar toda la matriz y tener métricas de discrepancia journal/documento. Kill switch de nuevos commits mantiene status, reconciliación y recuperación. No se eliminan tablas de journal ni versiones de contrato al revertir binarios.

**PR-05 — Layout, espaciado y reglas visuales deterministas · L**

**Depende de:** PR-02 y PR-03; puede avanzar en paralelo con PR-04 usando planes preparados. **Entradas:** intención, contenido, anclas y tokens del documento. **Salidas:** `canvas.layout`, medición y diagnósticos geométricos.

Implementar primero fila/columna/grid y flujo dirigido; luego swimlanes, mapas y composiciones con frames conforme al PRD. Incluir distancias, padding, alineación, distribución, tamaño tipográfico, routing y separación de labels. Respetar elementos fijados, relaciones existentes y espacio ocupado. Mantener el estilo del lienzo salvo cambio solicitado; no aplicar branding por nombre de carpeta.

**Pruebas/aceptación:** fixtures con textos cortos/largos, distintos idiomas y fuentes; ausencia de texto cortado y colisiones no intencionales; separación dentro de tolerancias declaradas; conectores asociados a IDs; una segunda aplicación del mismo layout no produce desplazamiento acumulativo. Ningún layout de una región mueve elementos ajenos.

**Release/rollback:** flag de layout; el executor básico sigue usable. Desactivar un algoritmo no modifica escenas ya colocadas.

**PR-06 — Diseñador conversacional y ciclo de revisión visual · L**

**Depende de:** PR-02, PR-04 y PR-05. **Entradas:** tools funcionales y corpus de tareas del PRD. **Salidas:** integración en chat y experiencia completa para el subconjunto inicial.

Flujo: entender petición → leer contexto/estilo → preparar → validar/organizar → renderizar/revisar preview → aplicar → leer y renderizar el documento vivo en `afterRevision` → revisar y, si procede, reparar → comprobar persistencia → explicar resultado. La preview no sustituye la revisión visual posterior al commit; cada reparación también se verifica sobre el resultado vivo. No exige que el usuario escriba JSON ni copie/importe manualmente una propuesta. Mostrar actividad, progreso, miniatura, enfocar, deshacer y estado de guardado. Las correcciones posteriores trabajan sobre IDs reales y alcance conversacional.

El modelo no declara éxito sin recibo; no confunde descripciones con inserciones. El límite de dos pasadas correctivas pertenece a `taskId`, no se reinicia al cambiar de tool o modelo. No gastar los 20 pasos en consultar repetidamente jobs; usar eventos y resultados compactos. Una petición nueva del usuario puede iniciar otra tarea.

**Pruebas/aceptación:** crear y refinar por conversación un funnel, organigrama y tablero mixto; conservar cambios manuales intercalados; enfocar el resultado; cancelar; deshacer el padre con todos sus hijos y rehacer con precondiciones vigentes. Capturar render `live` vinculado a `afterRevision` y demostrar inspección de sus píxeles; sembrar un cambio visual de observer/layout tras apply que no estuviera presente en la preview. La primera prueba oficial end to end requiere también el round-trip del subconjunto inicial en PR-08a. Evaluación visual con referencias humanas y rúbrica del PRD: ocho ejes de 1 a 5, promedio mínimo 4 y ningún eje inferior a 3; los fallos duros bloquean aunque el promedio pase. Las medidas y reglas específicas de tipografía/routing se desarrollan en `TASTE-Y-LAYOUT.md`. Reproducir resultados en las rutas de modelos admitidas, incluido fallback de un modelo sin visión.

**Release/rollback:** beta interna y luego allowlist de usuarios/workspaces. Si falla el gate de PR-04, esta PR sigue en preview. Desactivar el diseñador mantiene chat, edición manual y recibos.

**PR-07 — Cobertura de todas las familias nativas · L, dividir por familias**

**Depende de:** PR-01, PR-03 y PR-04. **Entradas:** matriz completa del manifiesto. **Salidas:** adapters de todas las capacidades editables restantes, incluidos contenido de notas, tablas/bases de datos, imágenes/adjuntos, embeds, enlaces documentales, trazos, mindmaps y referencias según sus reglas nativas.

Cada familia declara estructura válida, comportamiento de layout/render, dependencias y fidelidad de snapshot. No simular una tabla nativa con rectángulos ni un embed con texto cuando se pidió el bloque real. `page` y `surface` no se exponen como primitivas de dibujo. Referencias a otros documentos requieren permisos y política explícita de copia/enlace; las relaciones externas no se clonan accidentalmente.

**Pruebas/aceptación por familia:** crear/leer/modificar/mover/serializar/revertir todas sus operaciones admitidas; ciclos y assets faltantes; duplicación de IDs; render y colaboración; carga tras guardar. El manifiesto solo marca soportado lo probado. La entrega total exige cerrar toda la matriz, no alcanzar un porcentaje de bloques sencillos.

**Release/rollback:** capabilities y flags por familia; bloquear nuevas operaciones defectuosas conservando lectura/exportación del contenido existente.

**PR-08a — Intercambio nativo del subconjunto inicial · M**

**Depende de:** PR-01, PR-03 y PR-04; acompaña PR-06 antes de aceptar la primera prueba oficial. **Entradas:** adapters iniciales y contrato nativo. **Salidas:** export/import `.bs.zip` y snapshot de documento, frame o selección para formas, textos, notas, frames, grupos y conectores iniciales.

Reutilizar serialización nativa y el mismo apply/journal. Cubrir insertar en destino existente y crear documento nuevo por lifecycle, remapear IDs y conservar el original. No esperar a terminar familias avanzadas para demostrar el ciclo del funnel desde conversación.

**Pruebas/aceptación:** crear el funnel desde chat, refinarlo, mover un nodo a mano, deshacer/rehacer, exportar, reimportar en destino explícito y continuar editando sus modelos nativos. Comparar propiedades, contenido, conexiones y ámbito; comprobar recarga y documento fuente intacto.

**Release/rollback:** solo anuncia el subconjunto probado. La primera prueba oficial requiere PR-06 + PR-08a y el gate PR-04; desactivar import conserva exportación y contenido creado.

**PR-08b — Formato nativo e importación/exportación completa · L**

**Depende de:** PR-08a y adapters de PR-07. **Entradas:** snapshots nativos, assets, mapa de referencias. **Salidas:** paquete versionado de escena/documento y flujo común de import/export desde chat y UI para todas las familias.

Mantener separados el formato nativo de preservación y el formato semántico cómodo para autoría. Importar prepara un plan y reporte; aplicar usa el mismo executor/journal. Resolver colisiones de IDs, remapear grupos, conectores y mindmaps, validar assets y referencias entre documentos. Exportar devuelve handle/archivo autenticado con checksum, esquema y reporte. No introducir binarios base64 voluminosos en tools ni emitir descargas automáticas durante una revisión visual.

**Pruebas/aceptación:** exportar/importar/exportar fixtures de todas las familias mantiene contenido, jerarquía, propiedades y assets cubiertos; los IDs pueden cambiar mediante mapeo verificable. Paquetes malformados, versiones futuras y archivos incompletos no corrompen el destino. Importación grande reanudable, cancelable y sin duplicados; comportamiento definido ante cuotas y assets reutilizados.

**Release/rollback:** lector de versiones anteriores permanece disponible. Deshabilitar importación no elimina documentos importados ni corta exportación de recuperación.

**PR-09 — Interoperabilidad y formatos de presentación · M/L por formato**

**Depende de:** PR-02 y PR-08b para cobertura completa; adapters del subconjunto pueden adelantarse tras PR-08a. **Entradas:** formato nativo y matriz de compatibilidad. **Salidas:** import/export Excalidraw; import/export Mermaid flowchart; import/export Markdown de contenido; import/export FreeMind y OPML de mindmaps; exportación PNG/PDF. Cada dirección tiene un adapter y fixture explícitos. Conversores HTML/SVG son opcionales fuera del alcance obligatorio; `EmbedHtml` nativo sí permanece en la cobertura de bloques de PR-07.

Cada formato tiene su propio reporte `preserved/converted/flattened/unsupported`; ninguna conversión externa recibe etiqueta de fidelidad total si pierde semántica. PNG/PDF son formatos de presentación, no backups editables. La sintaxis externa se trata como datos y se valida antes de materializarla.

**Pruebas/aceptación:** corpus conocido por formato, conectores y labels remapeados, texto multilínea, fuentes, imágenes y tipos no equivalentes. Conversiones con pérdida producen reporte específico y previsión del resultado. Las capacidades anunciadas distinguen importar de exportar.

**Release/rollback:** flag por dirección/formato; fallo de un adapter no afecta nativo. Mantener el archivo original y la información necesaria para repetir la conversión.

**PR-10 — MCP sobre el mismo contrato · M**

**Depende de:** PR-04 y PR-08a para el subconjunto inicial; PR-07/08b/09 para las capacidades completas. **Entradas:** tools internas y autorización MCP. **Salidas:** registro MCP de capabilities/read/validate/layout/render/apply/operation/focus/import/export usando los mismos servicios.

Asignar un editor explícito autorizado, sin elegir silenciosamente entre pestañas ni inventar una sesión de chat. En la primera versión, sin editor adecuado devolver `EDITOR_UNAVAILABLE` con estado accionable. Un eventual executor headless tendrá capability y evaluación separadas; no se implementa duplicando escrituras Markdown sobre escenas de canvas.

**Pruebas/aceptación:** el mismo plan por chat y MCP produce un diff equivalente; `READ_ONLY` no puede aplicar/importar/revertir; versiones y schemas coinciden; reintentos, cancelación y errores preservan semántica. Un cliente externo puede crear un flujo y leer/verificar sus IDs reales.

**Release/rollback:** flag MCP write independiente de chat. Retirar tools de mutación conserva lectura, job status y artefactos autorizados.

**PR-11 — Calidad, rendimiento, lanzamiento y operación · L**

**Depende de:** hitos anteriores para cada capability que se vaya a publicar. **Entradas:** corpus completo y datos de beta. **Salidas:** gates automatizados, dashboard operativo y procedimiento de despliegue/rollback.

Medir éxito de tareas, ajustes manuales posteriores, calidad visual evaluada, latencias por fase, tamaño del plan, render/memoria, llamadas/tokens, reintentos deduplicados, conflictos, tiempo hasta persistencia, divergencias de journal y uso/fallos de undo. Registrar IDs y códigos; evitar guardar contenido privado completo en telemetría. Verificar documentos existentes, dispositivos lentos, dos pestañas, dos usuarios, offline/reconexión y cambios de renderer.

**Aceptación:** umbrales de rendimiento y calidad establecidos por PR-00/PRD cumplidos; cero divergencias no reconciliadas en la matriz de fallos; cobertura completa antes de anunciar soporte completo. Revisar permisos de assets, paquetes malformados, scopes y compatibilidad de versiones con pruebas que atraviesen capas reales.

**Release:** deploy aditivo → capacidades de lectura → usuarios internos → allowlist beta → ampliación gradual. Desplegar backend que entienda la versión antes de habilitar clientes que la emitan. Las capacidades efectivas dependen de flag, permiso, manifest y host, no solo de que exista código.

**Rollback:** detener trabajos nuevos y nuevos commits; mantener consultas, recuperación y sincronización de lo aplicado; reconciliar trabajos en vuelo; desactivar familia/ruta afectada; conservar snapshots, assets referenciados, journal y contratos anteriores. No ejecutar limpiezas masivas, restauraciones globales del documento ni migraciones destructivas como mecanismo de rollback.

**Hitos y dependencias**

1. **Preparación fiable:** PR-00 + PR-01 + PR-02. Leer, preparar y mostrar; sin escritura beta.
2. **Primera demo nativa:** PR-03 en entorno interno. No demuestra durabilidad ni cobertura total.
3. **Beta con escritura recuperable:** PR-04 completo; es una puerta obligatoria, no trabajo posponible de hardening.
4. **Primera prueba oficial end to end:** PR-05 + PR-06 + PR-08a sobre esa base, con revisión live y round-trip nativo del funnel.
5. **Cobertura e intercambio completos:** PR-07 + PR-08b + formatos del PRD en PR-09.
6. **Clientes externos y disponibilidad general:** PR-10 + gates de PR-11.

PR-02 y PR-03 pueden avanzar en paralelo tras el contrato. PR-05 puede trabajar sobre previews durante PR-04. Las familias de PR-07 y adapters de PR-09 pueden dividirse entre desarrolladores siempre que compartan registry y fixtures. No paralelizar cambios incompatibles al protocolo de commit antes de cerrar PR-00/04.

**Riesgos que deben permanecer visibles**

- Extender una tool de lectura con escrituras sin cambiar la semántica de revisión y ACK genera falsos fallos y duplicados.
- Tratar `transact` como rollback deja cambios parciales que el chat podría negar haber hecho.
- Usar preferencias de la herramienta manual como defaults del executor introduce variación visual y altera la experiencia del usuario.
- Deshacer mediante la pila global puede eliminar trabajo humano posterior; restaurar snapshots completos puede perder cambios remotos.
- Confundir estar cargado o sincronizado en general con haber persistido esta operación produce confirmaciones falsas.
- Un render dependiente del viewport, fonts o renderer puede omitir bloques. Una URL serializada no asegura que el modelo haya visto píxeles.
- Declarar «todos los bloques» a partir de formas y texto omite modelos complejos, assets y restricciones de padres.
- Serializar proyecciones de lectura como exportación pierde información. Los formatos externos no tienen equivalencia universal con AFFiNE.
- Aumentar pasos o reintentos sin un presupuesto de correcciones puede hacer que la IA reorganice indefinidamente el canvas.
- La versión de producción debe identificarse por build/commit para validar un rollout. Un `/info` con versión de producto no demuestra que coincida con este checkout.

**Matriz de dependencias para coordinación**

| PR     | Depende de                                         | Paralelismo permitido                                       | Gate de salida                                                             |
| ------ | -------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| PR-00  | PRD                                                | Spikes independientes con una decisión de commit compartida | Durabilidad/undo/visión caracterizados                                     |
| PR-01  | PR-00                                              | Registry y fixtures por familia                             | Contrato único y manifiesto explícito                                      |
| PR-02  | PR-01, spike visual                                | En paralelo con PR-03                                       | Lectura y píxeles verificables                                             |
| PR-03  | PR-01                                              | En paralelo con PR-02                                       | Executor preparado y postverificado                                        |
| PR-04  | PR-00, PR-03                                       | PR-05 sobre previews                                        | Journal durable + undo + ACK antes de beta write                           |
| PR-05  | PR-02, PR-03                                       | Durante PR-04                                               | Layout determinista y restricciones                                        |
| PR-06  | PR-02, PR-04, PR-05; PR-08a para primer end to end | Evaluación por escenarios                                   | Chat, render live, rúbrica visual y round-trip inicial                     |
| PR-07  | PR-01, PR-03, PR-04                                | Adapters por familia                                        | Matriz completa de tipos editables                                         |
| PR-08a | PR-01, PR-03, PR-04                                | Junto a PR-06                                               | Round-trip inicial antes del primer end to end                             |
| PR-08b | PR-08a, adapters PR-07                             | Fixtures por familia                                        | Round-trip nativo completo y assets                                        |
| PR-09  | PR-02, PR-08b; subconjunto tras PR-08a             | Adapters por formato/dirección                              | Excalidraw/Mermaid/Markdown/FreeMind/OPML bidireccionales y PNG/PDF export |
| PR-10  | PR-04, PR-08a; PR-07/08b/09 según capability       | Clientes de prueba independientes                           | Paridad MCP/chat y scopes                                                  |
| PR-11  | Gates de las capacidades a publicar                | Evals y rendimiento transversales                           | Release gradual y rollback ensayado                                        |

**Trazabilidad de requisitos del PRD**

| Requisito                        | Incrementos responsables      | Evidencia mínima de aceptación                                           |
| -------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| R-01 Creación nativa             | PR-03, PR-04, PR-06           | Objetos editables, IDs y recibo verificado desde chat                    |
| R-02 Capacidades reales          | PR-01, PR-07, PR-11           | Matriz versionada por tipo/operación y fixtures antes de supported       |
| R-03 Contexto y referencias      | PR-02, PR-06                  | Selección correcta, revisión vigente y ambigüedad reportada              |
| R-04 Representación apropiada    | PR-05, PR-06                  | Corpus de gramáticas y canon visual del PRD                              |
| R-05 Geometría explícita         | PR-05, PR-11                  | Error máximo de una unidad de canvas en fixtures compatibles             |
| R-06 Restricciones               | PR-03, PR-05                  | Bloqueos/anclas/ámbito respetados; conflicto antes de apply              |
| R-07 Tipografía y spacing        | PR-02, PR-05                  | Fuente real medida, contenido completo y separación verificable          |
| R-08 Criterio visual             | PR-05, PR-06                  | Rúbrica de ocho ejes, promedio ≥4, ninguno <3 y cero fallos duros        |
| R-09 Conectores                  | PR-03, PR-05, PR-08a/b        | IDs/rutas/labels correctos al mover, recargar e importar                 |
| R-10 Bloques y contenedores      | PR-01, PR-07                  | Todas las operaciones aplicables del inventario en supported             |
| R-11 Datos, imágenes, embeds     | PR-07, PR-08b                 | Modelos reales y blobs/referencias persistentes                          |
| R-12 Revisión estructural/visual | PR-02, PR-06                  | Píxeles live de afterRevision y postcondiciones verificadas              |
| R-13 Continuidad humana          | PR-04, PR-06                  | Ediciones locales/remotas intercaladas conservadas                       |
| R-14 Undo/cancel                 | PR-04, PR-06                  | Padre con sublotes+repairs, cancelación honesta y redo autorizado        |
| R-15 Ejecución fiable            | PR-00, PR-04, PR-11           | Retry, crash y ACK perdido sin duplicación ni falso éxito                |
| R-16 Persistencia/colaboración   | PR-04, PR-11                  | ACK de la operación, recarga y segunda sesión                            |
| R-17 Intercambio nativo          | PR-08a, PR-08b                | Documento/frame/selección con propiedades, assets y referencias          |
| R-18 Formatos externos           | PR-09                         | Fixtures por formato y dirección con pérdidas explícitas                 |
| R-19 MCP vivo                    | PR-10                         | Mismo contrato/resultado y destino vinculado al editor autorizado        |
| R-20 UX accesible                | PR-06, PR-11                  | Teclado/foco/estados/cámara del PRD sin regresión de edición manual      |
| R-21 Rendimiento/coste           | PR-00, PR-05, PR-11           | Límites/objetivos del PRD medidos, 20 pasos y máximo dos repairs         |
| R-22 Evaluación                  | PR-01, PR-06, PR-11           | Corpus versionado, evidencia conversacional y canon humano               |
| R-23 Lifecycle documental        | PR-03, PR-04, PR-08a/b        | Reserva/provisión idempotente, recuperación entre fases y origen intacto |
| R-24 Alcance/importación         | PR-01, PR-04, PR-08a/b, PR-09 | Validación de archivos/assets/permisos sin acciones externas implícitas  |

La matriz asigna trabajo y evidencia; no acredita pruebas realizadas. Los objetivos cuantitativos son los del PRD y se miden en el entorno fijado por PR-00.
