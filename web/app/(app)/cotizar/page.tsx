import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Quoter, type QuoterInitial } from "@/components/quoter/quoter";
import { quoteValidityDays } from "@/lib/branding";
import { getQuote } from "@/lib/quotes";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Cotizar" };

export default async function QuotePage({ searchParams }: { searchParams: Promise<{ repetir?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { repetir } = await searchParams;

  // "Repetir": precarga los estudios de una cotización anterior (con los precios vigentes de hoy).
  let initial: QuoterInitial | null = null;
  if (repetir) {
    const previous = await getQuote(repetir);
    if (previous) initial = { ids: previous.items.map((item) => item.labTestId), source: "repeat", patientName: previous.patientName };
  }

  return (
    <Quoter
      userId={session.userId}
      tariffName={session.organization?.tariffName ?? "Paciente"}
      validityDays={quoteValidityDays()}
      initial={initial}
    />
  );
}
