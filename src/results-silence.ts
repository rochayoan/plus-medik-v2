import { plain } from "./text-normalize.js";

// Regla explícita del negocio: recepción atiende las consultas EXCLUSIVAS sobre
// disponibilidad, enlace, descarga o entrega de resultados ya realizados.
// Aplicar a un LOTE COMPLETO (no al mensaje aislado) para no silenciar una
// cotización o urgencia que llegó en el mismo webhook.
const SUBJECT = /\b(resultado\w*|analisis|estudio\w*|laboratorio\w*|informe\w*|hemograma|glucosa)\b/;
const RESULTS = /\b(resultado\w*|informe\w*)\b/;
const REQUEST = /\b(ya|esta|estan|estara|estaran|listo\w*|salio|salieron|entrega\w*|entregar\w*|enviar\w*|envia\w*|mandar\w*|manda\w*|pasar\w*|pasen|recibir\w*|recoger\w*|retirar\w*|descarg\w*|obtener\w*|consultar\w*|link\w*|enlace\w*|acceso|clave|contrasena|disponible\w*|cuando|cuanto (tarda|demora)|tiempo)\b/;
const EXCLUDE = /\b(cotiz\w*|precio\w*|cuesta\w*|costo\w*|presupuesto\w*|pagar\w*|pago\w*|cobran|cuanto (sale|cuesta|cuestan|vale|valen)|ayuno\w*|preparaci\w*|muestra\w*|direccion\w*|ubicacion\w*|horario\w*|atienden|abren|cierra\w*|turno\w*|cita\w*|interpreta\w*|interpretar\w*|significa\w*|significado|explica\w*|valores|normal|alto\w*|bajo\w*|positivo\w*|negativo\w*|diagnostic\w*|tratamiento\w*|medicamento\w*|dolor\w*|fiebre|urgente\w*|urgencia\w*|emergencia|hospital\w*|internad\w*|hospitalizad\w*|doctor\w*|medico\w*|persona|asesor\w*|recepcion|humano|hablar|reclamo\w*|queja\w*|problema\w*|no puedo|no funciona|error\w*)\b/;

// No se hacen inferencias clínicas ni se inspeccionan datos del paciente.
// Ante mezcla de intenciones o incertidumbre, responder por el flujo vigente.
export function isResultsOnlyRequest(text: string): boolean {
  const message = plain(text.slice(0, 4000));
  if (!message || EXCLUDE.test(message)) return false;
  if (!RESULTS.test(message) && !(SUBJECT.test(message) && /\b(listo\w*|salio|salieron|entrega\w*|retirar\w*|recoger\w*)\b/.test(message))) return false;
  return REQUEST.test(message);
}
