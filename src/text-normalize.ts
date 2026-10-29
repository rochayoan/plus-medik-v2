// Normalización de texto del paciente para clasificar: sin tildes, mayúsculas, signos ni espacios repetidos ("¿¿CUÁNTO   CUESTA??" = "cuanto cuesta").
export const fold = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const plain = (text: string): string => fold(text).replace(/[^a-z0-9ñ]+/g, " ").trim();
export const words = (text: string): string[] => text.split(" ").filter(Boolean);
