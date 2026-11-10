# Configuración del agente Plusmedik: Git como fuente de cambios

## Decisión operativa

El responsable de un cambio de enlaces, imágenes públicas, ubicación, sucursales,
teléfonos, horarios, servicios, datos comerciales o estilo conversacional es
**quien tiene permisos de escritura en el repositorio**. La publicación se
realiza mediante Git + despliegue. **No se piden dos IDs del CRM, ni firma de
dos personas, ni aprobación en la bandeja G3.**

### Procedimiento

1. Editar `src/system-prompt.ts` (`BUSINESS_DATA` para información, `SYSTEM_PROMPT` para estilo).
2. Añadir el enlace HTTPS verificado (mapa o foto pública) en la sección apropiada.
3. Ejecutar `npm run agent-config -- check`, `npm run typecheck` y pruebas del agente.
4. Hacer commit y push a la rama que corresponda, con revisión según permisos normales del repositorio.
5. Desplegar **el servicio que efectivamente recibe Kapso** (hoy Vercel); no desplegar el CRM por cambiar este archivo.
6. Probar el mensaje desde un número controlado antes de dar la actualización por verificada.

### Alcance

- El control de versiones de Git no equivale a validación médica. No inventar
  datos ni copiar información clínica no verificada.
- Los precios y cotizaciones siguen saliendo del catálogo y su motor.
- Preparación clínica por estudio y otros datos que solo existan en la base
  siguen dependiendo del camino clínico hasta una migración específica.
- La interfaz histórica `src/knowledge/admin.ts` y las RPC `plusmedik_kb_*`
  **no deben utilizarse** para modificar configuración comercial a partir de ahora.
  No se eliminan por SQL en este cambio, para no afectar registros existentes.
- `crm_settings` pertenece al CRM y NO actualiza automáticamente el prompt
  del agente. Cambiar ese formulario no publica los enlaces del agente.
- Añadir una URL de foto habilita al agente a compartir un enlace si la
  respuesta está sustentada; **no configura mensajes multimedia salientes**.
- Las políticas de deploy (GitHub/CI) siguen vigentes; este procedimiento solo
  elimina la doble aprobación G3 como requisito de mantenimiento comercial.
