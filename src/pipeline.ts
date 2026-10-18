import { uniqueMatchedStudies, type CatalogResolver } from "./catalog.js";
import type { DisputeJudge, VisionReader } from "./ai.js";
import { fuseIndependentReadings, normalizeStudyKey } from "./consensus.js";
import { evaluateSafety } from "./safety.js";
import type { PipelineResult, StudyObservation } from "./types.js";

export class PlusMedikCore {
  constructor(
    private readerA: VisionReader,
    private readerB: VisionReader,
    private judge: DisputeJudge,
    private catalog: CatalogResolver
  ) {}

  async analyze(imageBase64: string, mimeType: string): Promise<PipelineResult> {
    const [a, b] = await Promise.all([
      this.readerA.read(imageBase64, mimeType),
      this.readerB.read(imageBase64, mimeType)
    ]);

    const fused = fuseIndependentReadings(a, b);
    let judgeResult: Awaited<ReturnType<DisputeJudge["judge"]>> | undefined;

    const finalMap = new Map<string, StudyObservation>();
    for (const item of fused.agreed) finalMap.set(normalizeStudyKey(item.text), item);

    if (fused.disputes.length > 0) {
      judgeResult = await this.judge.judge({
        imageBase64,
        mimeType,
        disputes: fused.disputes.map((d) => ({
          key: d.key,
          a: d.readerA,
          b: d.readerB
        }))
      });

      for (const item of judgeResult.requested) {
        const key = normalizeStudyKey(item.text);
        // El juez solo puede resolver una key que ya estaba en disputa.
        if (fused.disputes.some((d) => d.key === key)) finalMap.set(key, item);
      }
    }

    const finalRequested = [...finalMap.values()];
    const unresolvedVisualKeys = judgeResult?.unresolvedKeys ?? fused.disputes.map((d) => d.key);
    const catalog = finalRequested.map((item) => this.catalog.resolve(item));

    const safety = evaluateSafety({
      documentType: fused.documentType,
      completeDocumentVisible: fused.completeDocumentVisible,
      requested: finalRequested,
      unresolvedVisualKeys,
      catalog,
      visualUncertaintyCount: fused.uncertain.length
    });

    // Deduplicado por lab_tests.id: dos observaciones al mismo UUID son una sola línea y un solo cobro.
    const matched = uniqueMatchedStudies(catalog);
    const quote = safety.decision === "AUTO_SAFE"
      ? {
          lines: matched.map((study) => ({ id: study.id, code: study.code, name: study.name, priceBs: study.priceBs })),
          totalBs: matched.reduce((sum, study) => sum + study.priceBs, 0),
          tariff: "PACIENTE" as const
        }
      : undefined;

    return {
      visual: { fused, judge: judgeResult, finalRequested, unresolvedVisualKeys },
      catalog,
      safety,
      quote
    };
  }
}
