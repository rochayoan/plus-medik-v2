import type { ClientStudy } from "@/lib/catalog-types";

const study = (id: string, name: string, priceBs: number, extra: Partial<ClientStudy> = {}): ClientStudy => ({
  id,
  code: null,
  name,
  normalizedName: name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""),
  aliases: [],
  category: null,
  sampleType: null,
  priceBs,
  ...extra
});

export const studies: ClientStudy[] = [
  study("hemo", "Hemograma completo", 50, { code: "HEM01", aliases: ["hemograma", "bhc", "biometria hematica"], sampleType: "Sangre total" }),
  study("hba1c", "Hemoglobina glicosilada (HbA1c)", 120, { code: "HBA1C", aliases: ["hemoglobina glicosilada", "hba1c", "a1c"] }),
  study("gli", "Glicemia", 20, { code: "GLI01", aliases: ["glucosa", "glicemia en ayunas"] }),
  study("tsh", "TSH (ECLIA)", 90, { code: "178", normalizedName: "tsh eclia", aliases: ["tsh", "hormona tiroestimulante"] }),
  study("t4l", "T4 libre", 85, { aliases: ["t4l", "tiroxina libre"] }),
  study("col", "Colesterol total", 25, { aliases: ["colesterol"] }),
  study("tri", "Triglicéridos", 25, { aliases: ["trigliceridos"] }),
  study("lip", "Perfil lipídico", 90, { aliases: ["perfil lipidico", "lipidograma"] }),
  study("ure", "Nitrógeno ureico (BUN)", 25, { aliases: ["bun", "urea", "nitrogeno ureico"] }),
  study("cre", "Creatinina", 25, { aliases: ["creatinina serica"] }),
  study("got", "Transaminasa GOT (AST)", 30, { aliases: ["got", "ast", "tgo"] }),
  study("gpt", "Transaminasa GPT (ALT)", 30, { aliases: ["gpt", "alt", "tgp"] }),
  study("ego", "Examen general de orina", 30, { aliases: ["ego", "orina completa"] }),
  study("pcr-a", "Proteína C reactiva cuantitativa", 70, { aliases: ["pcr"] }),
  study("pcr-b", "PCR SARS-CoV-2 (molecular)", 350, { aliases: ["pcr"] })
];
