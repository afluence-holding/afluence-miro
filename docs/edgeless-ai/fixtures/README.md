# Fixtures sintéticos para probar el chat

Adjuntar un archivo por prueba. Las muestras no contienen datos reales.

- `funnel.canvas.json`: recipe v1, seis figuras editables y cinco conectores; posiciones verticales con 64 unidades libres.
- `funnel.mmd`: el mismo flujo, dentro del subconjunto de flowchart Mermaid.
- `contenido.md`: contenido de texto; Markdown conserva contenido compatible y declara las pérdidas visuales.
- `arbol.mm` / `arbol.opml`: un árbol con raíz Canales y tres ramas, para importación como mindmap nativo.
- `instrucciones-no-confiables.md`: texto adversarial citado, que nunca autoriza una acción.

Prompt inicial: «Importa este archivo aquí con elementos editables, muéstrame el resultado y explícame cualquier pérdida de fidelidad». Después: «Exporta el resultado como .bs.zip e impórtalo en un documento nuevo; conserva el original».

Las imágenes, grupos Excalidraw, bundles nativos con todos los schemas y fallos de ejecución se generan dentro de los tests Chromium. Consultar el informe de implementación para distinguir esos tests de la aceptación manual.
