**Contrato de dirección visual y disposición para Edgeless AI**

Estado del desarrollo: consultar [implementación, evidencias y activación](./IMPLEMENTACION.md). Este documento conserva la especificación de diseño; no certifica por sí mismo una prueba ni un despliegue.

Estado: propuesta de producto y contrato de implementación; no describe capacidades entregadas ni resultados de pruebas ejecutadas. Este documento desarrolla el componente visual del [PRD de Edgeless AI](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/docs/edgeless-ai/PRD.md). Si existe una discrepancia en herramientas, permisos o ciclo de ejecución, prevalece ese PRD.

El resultado esperado es que una persona describa un tablero en el chat y reciba una composición nativa, editable, legible y coherente; después debe poder refinarla mediante conversación y edición manual. La dirección visual comprende representación, jerarquía, contenido, posiciones, separación, rutas, contenedores y navegación. Añadir colores a una colección de cajas no satisface este contrato.

La IA propone intención, estructura y prioridades. Un motor calcula geometría y comprueba restricciones. La revisión visual evalúa si la composición comunica bien. Ninguno de esos tres componentes sustituye a los otros.

Todos los rangos y valores de diseño que se presentan como propuestas son defaults iniciales por calibrar con el corpus de aceptación. Las cifras identificadas como baseline son constantes observadas en el código, no recomendaciones nuevas ni evidencia de calidad conseguida. El máximo de dos pasadas correctivas adicionales y la puerta de aceptación de la rúbrica son decisiones propuestas de producto, todavía por implementar y verificar.

**Baseline verificado y trabajo pendiente**

| Área                 | Comportamiento presente en el código                                                                                                                                            | Consecuencia para la implementación                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medición de texto    | Existen medición DOM/canvas, wrapping, `normalizeShapeBound` y `fitContent`.                                                                                                    | Reutilizar la geometría del renderer; no aproximar anchuras contando caracteres.                                                                                                        |
| Tipografía           | Se registran Inter, Poppins, Kalam, Satoshi, Lora, Bebas Neue y Orelega One. Las formas usan Inter y tamaño 20 por defecto.                                                     | Elegir únicamente fuentes disponibles y comprobar su carga antes de medir.                                                                                                              |
| Carga de fuentes     | Algunas familias/pesos se cargan de forma diferida. `ready` espera las FontFaces registradas en el momento de consultar la propiedad.                                           | Esperar las fuentes concretas de la composición. Un `ready` anterior al registro de una fuente diferida no demuestra que esa fuente esté lista.                                         |
| Formas y notas       | Padding de forma: 20 horizontal y 10 vertical. Nota: ancho mínimo 218, inicial 498 y altura mínima 92.                                                                          | Los defaults visuales deben respetar los mínimos y la semántica de cada tipo.                                                                                                           |
| Colores              | Hay paleta nativa y valores con variantes de tema claro/oscuro.                                                                                                                 | Resolver colores con el tema real y conservar convenciones del tablero.                                                                                                                 |
| Disposición genérica | El autoarrange existente reparte elementos en filas de cuatro con gap 20; autoResize utiliza altura 200.                                                                        | No equivale a composición semántica de procesos, arquitectura, workshops o matrices.                                                                                                    |
| Mindmap              | Hay disposición recursiva, con separaciones nativas 45 vertical, 110 horizontal y 200 para el primer nivel. Su método `layout()` depende de la implementación de vista montada. | Reutilizar o adaptar el algoritmo; un proceso que solo escribe modelos no garantiza disposición completa.                                                                               |
| Frames               | Existe membresía explícita, orden de presentación y creación con padding 40. Algunas APIs reciben elementos pero consultan bounds de la selección actual.                       | Usar IDs y bounds del plan; no depender de una selección que el usuario puede cambiar durante la ejecución.                                                                             |
| Conectores           | El router ortogonal actual entrega a A* los bounds del origen y destino. El watcher recalcula rutas cuando cambian nodos.                                                       | Falta garantizar que las rutas eviten otros objetos y etiquetas. Integrar obstáculos en el ciclo persistente de routing; una ruta corregida solo una vez puede perderse al mover nodos. |
| Viewport             | Límites nativos de zoom 0.1–6 y padding general de fit 100.                                                                                                                     | El encuadre del resultado necesita ámbito propio y área útil real, especialmente con el chat abierto.                                                                                   |
| Transacciones        | `Store.transact` captura excepciones y las registra; no proporciona rollback de base de datos.                                                                                  | Preparar y verificar fuera del documento vivo. La validación geométrica no sustituye a validación de modelos ni postcondiciones de aplicación.                                          |

Fuentes de ese baseline:

- [Medición y normalización de formas](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/gfx/shape/src/element-renderer/shape/utils.ts:192), [medición DOM](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/gfx/text/src/element-renderer/utils.ts:46).
- [Fuentes disponibles](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/model/src/consts/text.ts:44), [defaults de formas](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/model/src/elements/shape/shape.ts:54), [mínimos de notas](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/model/src/consts/note.ts:5).
- [Carga diferida y readiness](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/shared/src/services/font-loader/font-loader-service.ts:24), [registro y carga de FontFaces](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/shared/src/services/font-loader/font-loader-service.ts:150).
- [Paleta nativa](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/model/src/themes/default.ts:8), [colores según tema](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/model/src/themes/color.ts:12).
- [Autoarrange](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/blocks/surface/src/commands/auto-align.ts:12), [disposición de mindmap](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/gfx/mindmap/src/view/layout.ts:10), [dependencia de vista de mindmap](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/model/src/elements/mindmap/mindmap.ts:719).
- [Membresía de frames](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/model/src/blocks/frame/frame-model.ts:28), [padding del frame](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/blocks/frame/src/frame-manager.ts:27), [dependencia de selección al crear un frame](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/blocks/frame/src/frame-manager.ts:343).
- [Obstáculos del router actual](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/gfx/connector/src/connector-manager.ts:1114), [recalcular rutas al editar](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/affine/gfx/connector/src/connector-watcher.ts:55).
- [Zoom nativo](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/framework/std/src/gfx/viewport.ts:19), [transacciones actuales](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/framework/store/src/model/store/store.ts:371).

**Modelo de composición y contrato de herramientas**

El motor recibe una escena semántica, no una lista obligatoria de coordenadas. Cada objeto tiene identidad estable de trabajo, tipo nativo previsto, contenido, rol, relaciones, contenedor y restricciones. Roles posibles: proceso, decisión, entrada, resultado, evidencia, riesgo, sección, persona responsable y anotación. Debe conservarse el vínculo entre el contenido de origen y el objeto que lo representa.

El plan preparado contiene: ámbito de edición, snapshot de referencia, representación escogida, estilo resuelto, objetos, relaciones, bounds previstos, fuentes necesarias, assets, restricciones, diagnóstico, patch propuesto y política de foco. Es inmutable una vez emitido para aplicación. Una reparación produce una versión nueva del plan; no cambia silenciosamente el significado de un `planId` ya presentado.

| Herramienta                       | Responsabilidad visual y relación con el plan                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `canvas.capabilities`             | Informa tipos, operaciones y capacidades de medición, render, layout y routing realmente disponibles. Distingue soporte nativo, soporte condicionado y tipos sin adaptador.          |
| `canvas.read`                     | Lee selección o IDs explícitos, regiones, geometría, contenido, relaciones, estilo, tema y restricciones relevantes. El ámbito queda fijado en el plan.                              |
| `canvas.validate`                 | Prepara un plan validado a partir de la intención y la escena; comprueba modelos, referencias, contenido, restricciones y disponibilidad de recursos. No modifica el tablero.        |
| `canvas.layout`                   | Prepara un plan de disposición sobre un ámbito definido. No muta el documento ni modifica la selección para obtener bounds.                                                          |
| `canvas.import`                   | Prepara plan y assets para el contenido importado. Conserva geometría y estilo cuando son representables; informa de pérdidas y conversiones. No aplica automáticamente.             |
| `canvas.render`                   | Produce evidencia visual del plan preparado o del resultado real. Debe indicar qué versión de plan/operación y qué ámbito muestra. No tiene efectos de escritura.                    |
| `canvas.apply(planId, requestId)` | Aplica el plan preparado con idempotencia, precondiciones y comprobación de resultados. Una nueva geometría exige un nuevo plan, no operaciones improvisadas dentro de esta llamada. |
| `canvas.operation`                | Informa estado, progreso y resultado de la operación, incluyendo verificación y problemas pendientes. El contrato de reversión corresponde al PRD.                                   |
| `canvas.focus`                    | Encuadra un ámbito explícito; cambia cámara, no geometría ni contenido.                                                                                                              |
| `canvas.export`                   | Exporta el ámbito solicitado y declara fidelidad. Verifica bounds, fuentes, assets y cortes de contenido en el formato elegido.                                                      |

Los nombres y argumentos completos de las herramientas corresponden al PRD. La tabla fija responsabilidades; no introduce un canal alternativo de escritura. Los datos e instrucciones incrustados en un tablero importado son contenido de la escena y no pueden cambiar este contrato.

**Requisitos funcionales verificables**

| ID     | Requisito                                                                                         | Evidencia de aceptación                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VIS-01 | Escoger una familia de diagrama adecuada al contenido y a las instrucciones.                      | La representación conserva relaciones y usa la gramática declarada; no transforma todo en una cuadrícula de cajas.                                              |
| VIS-02 | Resolver estilo con precedencia: instrucción del usuario, convenciones del ámbito, preset nativo. | El plan registra la procedencia de las decisiones. No aplica branding Afluence por directorio, dominio o nombre del producto.                                   |
| VIS-03 | Preparar planes sin mutar el documento vivo.                                                      | Documento, selección, cámara e historial mantienen su estado después de validate/layout/import/render, salvo recursos temporales de preparación documentados.   |
| VIS-04 | Calcular geometría en coordenadas del mundo y convertir pantalla mediante APIs del viewport.      | Cambiar el zoom no altera dimensiones o separación persistidas de una misma composición.                                                                        |
| VIS-05 | Esperar y medir las fuentes exactas usadas.                                                       | La prueba con caché fría produce texto íntegro y bounds consistentes tras terminar la carga.                                                                    |
| VIS-06 | Usar dimensiones visuales reales por tipo.                                                        | Notas escaladas, objetos rotados, etiquetas de conectores y bloques de altura variable no generan colisiones invisibles para el validador.                      |
| VIS-07 | Evitar pérdida de contenido y recorte de texto.                                                   | Todo fragmento de origen queda representado. Un resumen solo sustituye contenido cuando la instrucción lo autoriza.                                             |
| VIS-08 | Usar tokens de espaciado y jerarquía coherentes por rol.                                          | El diagnóstico compara objetos equivalentes; las excepciones tienen motivo explícito.                                                                           |
| VIS-09 | Mantener referencias y puertos nativos de los conectores.                                         | Mover nodos y recargar conserva conexiones semánticas; no quedan flechas unidas solo por coincidencia de coordenadas.                                           |
| VIS-10 | Incluir obstáculos de escena en routing y revalidar rutas después de cambios.                     | Las rutas no atraviesan cuerpos o textos ajenos dentro del alcance soportado; cualquier excepción se informa.                                                   |
| VIS-11 | Separar membresía de frame, bounds, título y orden de presentación.                               | El frame contiene los modelos correctos, deja libre su título y conserva su orden al exportar/importar cuando el formato lo admite.                             |
| VIS-12 | Respetar bloqueos nativos y posiciones fijadas en el plan.                                        | Objetos protegidos mantienen propiedades protegidas. Las restricciones incompatibles impiden aplicar un plan inválido.                                          |
| VIS-13 | Preservar cambios manuales por campo y usar layout incremental.                                   | Añadir una etapa no recolorea ni recoloca objetos manuales fuera de lo solicitado.                                                                              |
| VIS-14 | Limitar los cambios al ámbito definido.                                                           | No se modifican objetos fuera del ámbito; cambios de cámara o selección del usuario no cambian el objetivo del plan.                                            |
| VIS-15 | Detectar conflictos entre preparación y aplicación.                                               | Una edición concurrente relevante invalida o exige reconstruir el plan; no sobrescribe valores humanos con un snapshot antiguo.                                 |
| VIS-16 | Revisar el render y reparar con límite.                                                           | Después de la composición inicial hay como máximo dos pasadas correctivas adicionales, cada una con plan y diagnóstico identificables.                          |
| VIS-17 | Entregar un encuadre útil.                                                                        | El resultado se ve en el área disponible con el chat abierto; un objeto lejano no determina el zoom del lote recién creado.                                     |
| VIS-18 | Evaluar temas y legibilidad con colores resueltos.                                                | En tema claro y oscuro se distingue texto, jerarquía y conectores; el color no es el único indicador de estado.                                                 |
| VIS-19 | Conservar edición nativa a través de conversación y round-trip.                                   | Después de importar se pueden mover nodos, editar textos y continuar con herramientas según la matriz de fidelidad del formato.                                 |
| VIS-20 | Emitir diagnóstico honesto y medible.                                                             | Distingue preparado, aplicado, verificado y pendiente. Nunca presenta una puntuación o un render de preview como evidencia de que la escritura real tuvo éxito. |

**Coordenadas, zoom y geometría**

Los tokens de distancia y tamaño de este documento se expresan en unidades del mundo del canvas. A zoom 1, una unidad del mundo suele corresponder a un píxel CSS de la superficie, pero el motor no debe asumir equivalencia cuando intervienen escala de objetos, viewport o transformaciones del host. El factor de píxeles físicos del dispositivo afecta a la rasterización, no al layout persistido.

Invariantes:

- Cambiar de zoom modifica la cámara, no el tamaño de las figuras, los espacios entre ellas ni la tipografía guardada en los modelos.
- Mismo snapshot, fuentes, configuración y restricciones deben generar geometría determinista, independientemente del zoom inicial. Los IDs nativos nuevos pueden variar sin invalidar esa comparación geométrica.
- La selección es contexto inicial. Después de preparar un plan, sus IDs son la autoridad para el ámbito; no se consulta otra vez una selección mutable para decidir qué mover.
- Las operaciones relativas se resuelven con bounds de modelos: «a la derecha de este frame», «debajo de la nota», «alineado con este nodo». La IA no necesita deducir offsets del DOM.
- Las colisiones se evalúan con extents visibles. Para formas rotadas, usar geometría orientada cuando esté disponible y bounds envolventes conservadores como aproximación documentada. La medida del texto se calcula en el sistema local de su contenedor antes de aplicar transformaciones.
- No aplicar dos veces la escala de una nota. El adaptador convierte entre medidas de contenido, dimensiones del modelo y bounds visuales una sola vez, y debe probar ese contrato por tipo.
- Las etiquetas de conectores tienen bounds propios y forman parte del análisis. Los títulos de frame requieren una reserva visual aunque su renderer no forme parte del cuerpo del frame.
- Límites de frame, contenido, sombras relevantes y asas editoriales no se confunden. Los handles de selección transitorios no obligan a expandir permanentemente el layout.

El plan declara cómo trata elementos parcialmente fuera del ámbito y contenedores anidados. Cuando un elemento protegido ocupa el único espacio factible, el motor amplía el área autorizada si el contrato lo permite o devuelve conflicto; no desplaza silenciosamente contenido ajeno.

**Medición de texto y contenido dinámico**

Crear un adaptador de medición por familia: formas/texto canvas, texto enriquecido, notas, tablas/data-view, imágenes, adjuntos, embeds y mindmaps. Cada adaptador devuelve tamaño mínimo, tamaño preferido, política de crecimiento, bounds de texto y estado de preparación. Un tipo sin medida fiable no se declara totalmente compatible con layout automático.

Para texto se requiere familia, peso, estilo, tamaño, ancho disponible, padding y contenido enriquecido. El servicio de fuentes debe garantizar las variantes exactas antes de medir, incluida una familia diferida que todavía no estaba registrada al consultar `FontLoaderService.ready`. Si la fuente falla, escoger una sustitución aprobada y volver a medir, o producir un error de preparación explícito. No aceptar métricas de fallback como si pertenecieran a la fuente solicitada.

Etiquetas largas pueden ampliar ancho/alto, usar saltos de línea o separar título y explicación en bloques relacionados. No reducir indefinidamente tamaño de texto, truncar sin indicación ni omitir URLs o identificadores necesarios. Si el usuario proporciona un título extenso, el motor conserva ese contenido y decide una representación que lo soporte.

Las formas equivalentes comparten anchura cuando facilita comparación, pero no altura fija que recorte información. Los rombos contienen decisiones breves; explicaciones adicionales se representan en una nota asociada. Las tablas conservan sus filas, columnas y vista reales. No simularlas con rectángulos para facilitar el layout.

Assets y embeds deben tener dimensiones conocidas o una reserva explícita. Tras montar bloques dinámicos, comprobar su tamaño real. El resize posterior puede activar reparación local y acotada si el ámbito sigue siendo automático; no autoriza relayout global ni desplazamiento de objetos fijados.

**Restricciones duras y preferencias**

| Clase  | Restricción                                                                                | Tratamiento                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Dura   | Coordenadas finitas, tamaños positivos y mínimos nativos.                                  | Rechazar geometría inválida antes de aplicar.                                                                |
| Dura   | Identidades, referencias, padres y membresías válidos.                                     | Validación de modelos y relaciones; no basta con que el preview parezca correcto.                            |
| Dura   | Contenido completo y texto sin recorte.                                                    | Verificación de origen a modelo y de bounds de texto.                                                        |
| Dura   | Ausencia de solapamiento involuntario entre cuerpos.                                       | Excluir explícitamente contención, fondos y superposición solicitada; no usar una excepción global por tipo. |
| Dura   | Conectores sin atravesar cuerpos o texto de terceros para los casos declarados soportados. | Validar toda la ruta contra obstáculos; informar cuando una combinación de restricciones impide cumplirlo.   |
| Dura   | Objetos protegidos y campos manuales preservados.                                          | Precondiciones por campo y scope; los bloqueos nativos son independientes de preferencias visuales.          |
| Dura   | Bounds y reserva de título del frame coherentes con su contenido.                          | Expandir solo frames que el plan permite redimensionar.                                                      |
| Dura   | Operación limitada al ámbito y sin cambios semánticos no solicitados.                      | Comparar patch y snapshot.                                                                                   |
| Blanda | Minimizar cruces entre conectores.                                                         | Penalización; no prometer cero cruces para cualquier grafo.                                                  |
| Blanda | Minimizar codos, longitud innecesaria y entradas por lados incoherentes.                   | Optimización de routing según la familia del diagrama.                                                       |
| Blanda | Conservar la posición relativa de objetos existentes.                                      | Penalizar movimiento; preferir desplazamiento local sobre recomposición global.                              |
| Blanda | Alineación, ritmo, tamaños equivalentes y balance visual.                                  | Tokens por rol y diagnóstico de excepciones.                                                                 |
| Blanda | Compacidad y aprovechamiento del espacio.                                                  | No prevalece sobre legibilidad ni preservación de contenido.                                                 |

Orden de prioridades: fidelidad semántica, protección del trabajo humano, legibilidad, restricciones geométricas, orden de lectura, consistencia y compacidad. Una puntuación visual alta no compensa un fallo duro. Si restricciones explícitas son incompatibles, el plan describe cuáles chocan; no simula cumplimiento.

**Tokens iniciales y política de densidad**

Esta tabla propone defaults para calibración; no cambia las constantes nativas de manera automática. Los adaptadores pueden conservar valores del tablero o del tipo cuando están mejor justificados. Todas las distancias y tamaños son unidades del mundo, no píxeles de pantalla dependientes del zoom.

| Token o rol                           |                  Default/rango inicial propuesto | Uso                                                      |
| ------------------------------------- | -----------------------------------------------: | -------------------------------------------------------- |
| Padding de etiqueta de forma          |                      20 horizontal / 10 vertical | Punto de partida compatible con el renderer nativo.      |
| Gap entre tarjetas hermanas           |                                            32–48 | Lectura de grupos y comparación de objetos equivalentes. |
| Gap entre niveles de flujo            |                                            64–96 | Reservar espacio para rutas y etiquetas.                 |
| Separación entre secciones            |                                           96–160 | Distinguir agrupaciones sin depender solo de color.      |
| Padding del contenido de frame        |                                            40–64 | Más reserva independiente para el título.                |
| Metadatos y etiquetas secundarias     |                                               16 | Tamaño inicial; no usar para todo el cuerpo.             |
| Texto principal                       |                                               20 | Punto de partida para nodos y notas resumidas.           |
| Título de sección                     |                                               28 | Nivel intermedio de jerarquía.                           |
| Título principal                      |                                               36 | Título del conjunto o frame principal.                   |
| Familias tipográficas por composición | Una principal; segunda solo con función definida | Evitar variación arbitraria entre nodos.                 |

La densidad `compacta`, `normal` o `amplia` ajusta separación y anchuras preferidas. No reduce automáticamente la tipografía por debajo de los mínimos del preset. No se exige que todo el tablero quepa simultáneamente en pantalla: un tablero grande necesita navegación y frames legibles.

Configuración inicial reproducible, propuesta para versión 1 del preset y sujeta a calibración explícita con el corpus:

| Distancia en unidades del canvas  | Compacta | Normal | Amplia |
| --------------------------------- | -------: | -----: | -----: |
| Hueco entre tarjetas hermanas     |       32 |     40 |     48 |
| Hueco entre niveles de un flujo   |       64 |     80 |     96 |
| Separación entre grupos/secciones |       96 |    128 |    160 |
| Padding de contenido del frame    |       40 |     48 |     64 |

Estos valores son distancias mínimas entre bordes cuando el usuario pide disposición automática. El routing, el contenido o los mínimos del bloque pueden exigir más espacio y el plan registra la excepción. Una medida explícita del usuario, como «exactamente 64 unidades», tiene prioridad y se trata como restricción requerida; si es incompatible, se devuelve conflicto en lugar de ampliarla silenciosamente. La reserva de título del frame se añade después de medir su geometría real. La tipografía conserva los mismos roles y mínimos entre densidades; compactar no equivale a disminuir la letra.

Para evitar variación entre reintentos, el plan guarda la versión del preset y del motor, la fuente resuelta, el orden estable de nodos y el criterio de desempate del solver. Volver a aplicar una disposición sobre el mismo estado y las mismas restricciones no debe generar deriva acumulativa.

Medir consistencia entre objetos comparables, no entre todos los elementos del mundo. Un título principal, una nota de detalle y una decisión no requieren las mismas dimensiones. Las excepciones al ritmo deben corresponder a contenido, jerarquía o restricciones humanas, no a ruido aleatorio del generador.

**Familias de diagrama y gramática visual**

| Familia                  | Decisiones de composición                                                                                        | Comportamiento que debe evitar                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Proceso y funnel         | Eje principal explícito; procesos consistentes; decisiones diferenciadas; etapas y resultados reconocibles.      | Serpenteo arbitrario, flechas ambiguas y color diferente en cada etapa sin significado.                 |
| Arquitectura de sistemas | Contenedores por sistema/responsabilidad, límites visibles, puertos, separación de conexiones internas/externas. | Flechas que atraviesan módulos ajenos y proximidad que sugiere relaciones inexistentes.                 |
| Workshop y afinidad      | Notas legibles, clusters por tema, títulos y espacio para incorporar ideas.                                      | Uniformar toda la información como flujo secuencial aunque no tenga orden.                              |
| Mindmap                  | Árbol nativo, jerarquía por profundidad y balance por subárbol; color opcional por rama.                         | Simular el árbol mediante figuras desconectadas o usar el mismo espaciado sin considerar descendientes. |
| Roadmap y timeline       | Eje temporal declarado, hitos y lanes por área/propietario.                                                      | Distancias que aparentan escala temporal proporcional cuando representan solo orden.                    |
| Comparación y matriz     | Filas/columnas alineadas, criterios comunes, tamaños comparables y cabeceras persistentes.                       | Cambiar significado de ejes o desalinear categorías al añadir información.                              |
| Tablero de información   | Frames con jerarquía; mezcla justificada de notas, tablas, databases, documentos e imágenes.                     | Convertir bloques ricos en capturas o decoraciones no editables.                                        |
| Presentación             | Frames secuenciados, tipografía por frame, encuadre y orden de presentación nativo.                              | Tablero inmenso legible únicamente a zoom excesivo o frames con contenido cortado.                      |

La familia elegida y la dirección de lectura se incluyen en el plan. Una petición posterior puede cambiarla, pero esa conversión debe conservar contenido y relaciones; no se trata como simple cambio de coordenadas.

**Dirección visual, colores y continuidad del tablero**

La precedencia es: instrucciones explícitas del usuario, convenciones del área en edición, preset nativo apropiado. El estilo de una zona no se deduce solo del último objeto editado. El motor identifica patrones por roles y contenedores y limita su inferencia al ámbito relevante. No aplica automáticamente branding Afluence.

El color expresa categoría, estado, rama o énfasis. Si varios colores tienen significado, el significado queda disponible en etiquetas o leyenda cuando sea necesario. No depender exclusivamente del color para distinguir riesgo, aprobación o decisión. Fondos, bordes, sombras, esquinas y estilo de trazo deben tener consistencia por rol.

Revisar texto, borde y conector usando el color final resuelto para el tema. Contraste, tamaño y densidad se evalúan conjuntamente en un zoom de trabajo declarado. Un preset no se considera validado porque su versión clara sea legible; se prueba también la variante oscura si la aplicación permite usarla.

Los presets deben modificar representación, jerarquía y composición cuando corresponde. Cambiar colores sobre una única plantilla no cubre todas las familias del cuadro anterior. La novedad visual no es una métrica de calidad ni justifica romper la continuidad de un tablero existente.

**Routing, etiquetas y contenedores**

Asignar puertos de entrada y salida según dirección y papel de la relación. Preferir un recorrido recto cuando comunica bien; usar ortogonales para procesos y arquitectura cuando reducen ambigüedad. Reservar corredores para conexiones, distinguir retornos/excepciones del trayecto principal y evitar codos innecesarios.

El conjunto de obstáculos incluye cuerpos de elementos, texto, etiquetas de conectores y reserva de títulos de frame. Las fronteras de contenedores requieren una política explícita: cruzar el límite del contenedor propio puede ser necesario; atravesar el título o un contenedor ajeno no debe suceder accidentalmente. La contención intencional no se interpreta como colisión entre cada hijo y su frame.

Ubicar etiquetas sobre un tramo suficiente y asociarlas visualmente a una sola relación. Cuando varias ramas parten de una decisión, las etiquetas deben dejar inequívoco a qué camino pertenecen. No pintar texto flotante que pierde su vínculo al mover nodos.

La implementación necesita ampliar el routing nativo o integrar una política equivalente que conozca obstáculos de escena. Los watchers deben usar esa política en actualizaciones posteriores. No sustituir conectores nativos por SVG superpuesto ni asumir que asignar una ruta calculada una vez la hará estable.

Frames tienen cuatro aspectos independientes: membresía, bounds visuales, título y orden de presentación. Recalcular cada uno cuando la operación lo exige. Grupos tienen identidad y jerarquía propias. Crear un fondo alrededor de varios nodos no equivale a agruparlos o introducirlos en un frame.

**Bloqueos, posiciones fijadas y edición manual**

Los bloqueos nativos se consultan con `isLocked()`, incluyendo ancestros; no basta comprobar `lockedBySelf`. Ver [contrato de bloqueo de modelos gráficos](/Users/santander/Documents/ChatGPT/Miro/afluence-miro/blocksuite/framework/std/src/gfx/model/base.ts:70).

Además del bloqueo nativo, el plan puede proponer políticas de disposición `auto`, `fixed` y `preserve`. Estas políticas son metadatos de la capa de IA o de composición mientras no se implemente una extensión nativa; no se presupone la existencia de una propiedad nativa llamada `pinned`.

Registrar el snapshot de referencia, geometría del último resultado IA, origen de la operación y campos cambiados después por interacción humana. Que un objeto haya sido creado por IA no da permiso permanente para sobrescribir sus propiedades.

| Acción posterior                         | Comportamiento esperado                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| «Añade una etapa»                        | Insertar y reajustar el vecindario necesario; conservar colores y posiciones protegidas.                 |
| «Hazlo más compacto»                     | Proponer cambios de espaciado dentro del ámbito y respetar texto mínimo y elementos fijados.             |
| «Reorganiza este frame»                  | Recomponer ese frame conforme al scope, preservando elementos fijados y relaciones.                      |
| «Mantén esto donde lo puse»              | Registrar una restricción explícita de geometría sin fingir un bloqueo nativo inexistente.               |
| «Cambia el color de las decisiones»      | Actualizar ese rol, conservando contenido, coordenadas y otros estilos no solicitados.                   |
| «Redistribuye todo, también lo que moví» | La nueva instrucción puede ampliar el ámbito de layout; los permisos y bloqueos nativos siguen vigentes. |

Antes de aplicar, comparar las propiedades que el plan tocará con su snapshot. Un cambio humano relevante requiere reconstrucción del plan o un conflicto explícito. Los cambios independientes que no alteran esas precondiciones no deberían invalidar innecesariamente toda la operación. El contrato exacto de revisión y concurrencia queda en el PRD.

**Preview, aplicación y reparación limitada**

La composición inicial se prepara y renderiza en un entorno temporal con esquemas, fuentes y comportamiento de vista equivalentes al editor de destino. No usar la transacción del documento vivo como sandbox reversible. Un render de preview se identifica siempre como preview.

Después de preparar el plan:

1. Ejecutar chequeos de modelos, contenido, geometría y ámbito.
2. Renderizar el área planificada y revisar legibilidad, jerarquía y relaciones.
3. Si procede, preparar y evaluar una corrección localizada.
4. Permitir como máximo dos pasadas correctivas adicionales a la composición inicial, contando las reparaciones automáticas del mismo pedido tanto antes como después de aplicar. Un retry técnico idempotente no cuenta como rediseño; no debe crear elementos duplicados.
5. Aplicar únicamente un plan que supere los chequeos previos obligatorios.
6. Esperar render real y comprobar postcondiciones. Si hace falta corregir y queda presupuesto de pasadas, preparar un nuevo plan localizado y aplicar mediante el mismo contrato.
7. Al agotar las pasadas, informar del problema concreto. No presentar el resultado como verificado ni entrar en un bucle de cambios silenciosos.

El límite de correcciones no permite omitir validaciones duras. Si se descubre un fallo después de escribir, marcar la operación como necesitada de atención y seguir la política de recuperación/reversión del PRD; no ejecutar un `undo()` global que pueda revertir una edición humana posterior.

La crítica visual recibe el brief, la familia elegida, el scope, las restricciones protegidas y el render. Puede detectar ambigüedad que no aparece en bounds, pero no puede inventar métricas ni declarar referencias válidas sin comprobar los modelos. Las reparaciones se acotan a los defectos detectados; una objeción estética no autoriza a cambiar contenido.

**Foco, navegación y entrega en el chat**

El área útil para presentar un resultado descuenta el panel de chat, barras y otras obstrucciones del editor. El motor usa bounds del lote o frame solicitado, no el conjunto completo de objetos del documento. Un elemento lejano no debe reducir el zoom de la nueva composición.

La entrega prioriza un encuadre legible del resultado y navegación por secciones cuando el tablero es grande. El overview puede mostrar estructura general sin hacer legibles todos los detalles; el zoom de trabajo debe permitir leer el contenido del frame enfocado. No usar la capacidad de zoom hasta 0.1 como excusa para construir contenido excesivamente denso.

No mover la cámara por cada nodo. Se pueden revelar lotes o secciones coherentes y mostrar progreso, pero la cámara no debe disputar el control al usuario. Si la persona cambia de documento o cierra el editor, el sistema no escribe en otra instancia ni roba su foco; se aplica el manejo de sesión definido en el PRD.

La respuesta del chat distingue qué creó o cambió, qué comprobó y si queda alguna limitación. «Listo» requiere evidencia del documento real, no solo la imagen de un plan. El usuario debe poder continuar con referencias naturales a los objetos recién creados, sustentadas por IDs y contexto de operación.

**Rúbrica visual y criterios de salida**

Usar ocho dimensiones puntuadas de 1 a 5. Las puntuaciones 2 y 4 representan estados intermedios entre los anclajes adyacentes. La puerta propuesta es media igual o superior a 4 y ninguna dimensión inferior a 3, además de cumplir todos los chequeos duros. Es un objetivo de aceptación por validar con ejemplos; no una medida ya alcanzada por el sistema.

| Dimensión         | 1 — deficiente                                                                | 3 — suficiente                                                                 | 5 — excelente                                                                                        |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Estructura        | La representación cambia o confunde relaciones esenciales.                    | Relaciones correctas y formato pertinente, con alguna agrupación mejorable.    | La representación permite identificar de inmediato propósito, relaciones y prioridades.              |
| Legibilidad       | Texto ilegible, recortado o etiquetas ambiguas.                               | Se lee en el zoom de trabajo; algunos bloques son densos o requieren atención. | Texto, etiquetas y conexiones se leen con comodidad y sin zonas de esfuerzo evitable.                |
| Jerarquía         | Todo compite visualmente o no hay niveles claros.                             | Título, secciones y cuerpo son distinguibles y consistentes.                   | La jerarquía guía la exploración y facilita volver a localizar información.                          |
| Composición       | Alineación, espacio y agrupación impiden seguir el contenido.                 | Orden de lectura y grupos claros; hay irregularidades menores.                 | Ritmo, balance y espacio hacen evidente la estructura sin decoración explicativa.                    |
| Rutas             | Conexiones incorrectas, cuerpos atravesados o etiquetas sin asociación clara. | Relaciones nativas correctas y legibles; quedan recorridos mejorables.         | Puertos, trayectos, retornos y etiquetas reducen al mínimo el esfuerzo para seguir relaciones.       |
| Consistencia      | Roles iguales reciben estilos incompatibles sin motivo.                       | Los roles principales son consistentes; hay pocas excepciones justificables.   | Todos los roles mantienen convenciones claras, con excepciones intencionales por contenido.          |
| Contención visual | Color y decoración distraen o sugieren significado falso.                     | Los recursos visuales aportan función y el conjunto no está sobrecargado.      | Cada énfasis tiene propósito; la composición comunica con economía y carácter propio del tablero.    |
| Continuidad       | Se pierde contenido o se sobrescribe trabajo manual ajeno al pedido.          | La edición conserva información, estructura y restricciones solicitadas.       | La modificación encaja naturalmente en el tablero y preserva decisiones humanas con cambios mínimos. |

Un fallo duro puede impedir la salida aunque la dimensión afectada no se refleje adecuadamente en una media. Los anclajes deben acompañarse de un corpus de renders aprobados y rechazados. Revisar una muestra fija con una persona experta, usando los mismos briefs y criterios. La evaluación del propio modelo es apoyo; no es el único árbitro de calidad.

Registrar por plan/operación métricas separadas: recortes de texto, área de solapamiento involuntario, rutas que cruzan obstáculos, referencias inválidas, desviación de alineación entre pares comparables, dispersión de gaps por rol, campos protegidos modificados y desplazamiento total del vecindario existente. Sus umbrales cuantitativos y presupuestos de rendimiento se fijarán tras medir el corpus. No publicar porcentajes de calidad sin denominador, casos y método de evaluación.

**Casos de prueba de conversación y diseño**

Las cantidades de objetos que aparecen en estos casos describen fixtures propuestos de prueba; no son límites de producto ni garantías de rendimiento. Cada caso debe guardar brief, snapshot inicial, planes, render antes/después, diagnóstico, versión del motor y resultado de las aserciones.

| Caso                               | Conversación o preparación                                                                                                             | Comprobaciones principales                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| TASTE-01 — funnel                  | «Crea un funnel de seis etapas, de atracción a seguimiento; añade una decisión de compra y una ruta de abandono».                      | Eje claro, etapas legibles, decisiones diferenciadas, conectores por IDs, ramas etiquetadas y ausencia de colisiones.                           |
| TASTE-02 — tipografía fría         | Repetir creación con caché fría usando una fuente diferida, acentos, identificadores largos y saltos de línea.                         | La fuente exacta está lista antes de aceptar medidas; no hay recorte después de carga, recarga o exportación.                                   |
| TASTE-03 — invariancia de zoom     | Preparar la misma composición con viewport inicial 0.25, 1 y 2, usando la misma ancla del mundo.                                       | Geometría persistida equivalente; solo cambia la cámara. No aparece escala doble en notas.                                                      |
| TASTE-04 — obstáculos              | Conectar dos nodos separados por una tercera nota y un título de frame; mover extremos y recargar.                                     | Las rutas evitan los obstáculos y mantienen enlaces/etiquetas después del watcher y de reapertura.                                              |
| TASTE-05 — edición humana          | Crear el funnel; mover y recolorear dos notas a mano; fijar una; pedir «añade una etapa y compacta el resto».                          | Conservar campos manuales y ancla fija; scope incremental; no reescribir todo el tablero.                                                       |
| TASTE-06 — contenido dinámico      | «Añade una tabla con responsables y fechas»; añadir filas y alternar una database entre tabla y kanban.                                | Bloques nativos, bounds reales, contenido completo, frame expandido solo si está permitido y reparación acotada.                                |
| TASTE-07 — mindmap                 | «Convierte estas ideas en un mapa mental» con ramas de profundidad desigual; añadir una subrama extensa.                               | Árbol nativo, layout de vista disponible, tamaños medidos, subárboles sin solapamiento y raíz estable cuando esté fijada.                       |
| TASTE-08 — tablero mixto           | «Haz un tablero por secciones con contexto, flujo, evidencias y responsables», incluyendo notas, imagen, adjunto y documento enlazado. | Familia y bloques adecuados, jerarquía de frames, estilo coherente y assets válidos.                                                            |
| TASTE-09 — encuadre                | Abrir chat lateral, dejar un objeto muy lejano y pedir una composición junto al frame visible.                                         | Colocación correcta en mundo, área útil sin ocultar el resultado y foco del lote; no fit global minúsculo.                                      |
| TASTE-10 — conflicto               | Preparar layout; antes de apply otro usuario cambia un nodo objetivo y la persona local cambia su selección.                           | Las precondiciones detectan el cambio relevante; la selección nueva no cambia los IDs objetivo.                                                 |
| TASTE-11 — restricciones inviables | Fijar todos los objetos dentro de un frame de tamaño fijo sin espacio y pedir añadir una tarjeta grande.                               | Diagnóstico explícito de conflicto, sin mover protegidos ni ocultar contenido para aparentar éxito.                                             |
| TASTE-12 — temas y presentación    | Crear varios frames para presentar; alternar claro/oscuro y navegar su secuencia.                                                      | Colores resueltos legibles, jerarquía estable, títulos libres, orden nativo y foco por frame.                                                   |
| TASTE-13 — round-trip              | «Exporta este tablero»; importar en otro documento; «añade un paso al flujo importado».                                                | Fidelidad conforme al formato declarado, edición nativa y relaciones recuperadas. Las pérdidas se informan, no se ocultan detrás de una imagen. |
| TASTE-14 — límite de reparación    | Introducir un fixture cuyo crecimiento asíncrono siga produciendo un defecto después de dos correcciones.                              | No hay una tercera corrección automática adicional; estado real y problema pendientes quedan visibles, sin falso éxito.                         |
| TASTE-15 — rúbrica                 | Comparar renders del corpus aprobados y deliberadamente deficientes usando la tabla de anclajes.                                       | El gate se calcula de forma reproducible, se conservan puntuaciones individuales y los errores duros bloquean salida.                           |

**Cinco riesgos que deben mantenerse visibles durante la implementación**

| Riesgo                                                 | Mecanismo                                                                       | Mitigación obligatoria y prueba                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Texto que cambia de tamaño después de aparecer         | Métricas tomadas antes de cargar la fuente; cachear fallback como fuente final. | Garantizar familia/peso/estilo concretos, invalidar mediciones afectadas y verificar render. TASTE-02. |
| Flechas que atraviesan objetos o pierden la corrección | Router actual centrado en extremos y watcher que regenera la ruta.              | Integrar obstáculos en routing estable y probar movimiento, recarga y etiquetas. TASTE-04.             |
| La IA borra decisiones manuales mediante relayout      | Sin ownership por campo, scope ni comparación de snapshots.                     | Anclas, protección por campo y precondiciones; layout incremental. TASTE-05 y TASTE-10.                |
| Bloques ricos desbordan contenedores                   | Altura real aparece después de montaje, assets o cambio de vista.               | Adaptador de medida por tipo, reserva explícita y reparación local limitada. TASTE-06 y TASTE-14.      |
| Resultado correcto pero invisible o minúsculo          | Confundir pantalla/mundo, escala duplicada o encuadrar todo el documento.       | Invariantes de transformación, bounds del lote y área útil del viewport. TASTE-03 y TASTE-09.          |

**Entregables de implementación**

- Motor de composición determinista con familias semánticas, restricciones y estilo resuelto.
- Adaptadores de medida y geometría por tipo, incluyendo preparación explícita de fuentes y assets.
- Routing integrado con obstáculos, etiquetas y recálculo al editar.
- Registro de planes, precondiciones, ámbitos y protección de cambios manuales.
- Preview equivalente al renderer de destino, verificación tras aplicación y reparación limitada.
- Presets nativos versionados con tokens iniciales calibrados sobre ejemplos aprobados.
- Diagnóstico geométrico y evidencia visual vinculados a plan/operación.
- Corpus conversacional, fixtures de concurrencia/zoom/temas y evaluación visual con los anclajes anteriores.

La capacidad se considera lista para probar hablando con la IA cuando el circuito completo —preparar, mostrar, aplicar, verificar, editar manualmente y continuar por chat— funciona sobre los tipos declarados y conserva sus invariantes. La primera imagen convincente no es por sí sola el criterio de salida.
