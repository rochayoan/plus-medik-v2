# Instrucciones para quienes mantienen Plusmedik

- **Configuración comercial del agente:** editar `src/system-prompt.ts`
  (`BUSINESS_DATA` / `SYSTEM_PROMPT`) mediante cambios de Git.
- **No solicitar dos IDs de CRM ni aprobaciones G3** para actualizar enlaces
  Google Maps, URL de fotos, sucursales, horarios, teléfonos u otra información
  pública del agente. No llamar las RPC `plusmedik_kb_create_draft`,
  `plusmedik_kb_submit` ni `plusmedik_kb_approve` para estos cambios.
- Validar fuente, vigencia, formato y contenido de la sección. No inventar
  información comercial ni clínica. Aplicar pruebas y publicar por deploy.
- **No confundir** archivos del agente con `crm_settings` del frontend CRM:
  no existe sincronización automática entre ambas fuentes.
- En cambios clínicos, cotizaciones, permisos de usuarios o pacientes, conservar
  los controles técnicos vigentes; no modificar datos médicos sin verificar.
- La información sobre esta política está en
  `docs/configuracion/repositorio-sin-aprobacion.md`.
