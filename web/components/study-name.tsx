import { splitStudyName } from "@/lib/study-name";

// Solo el título; lo que incluye el estudio queda plegado ("Ver qué incluye").
export function StudyName({ name, className }: { name: string; className?: string }) {
  const { title, detail } = splitStudyName(name);
  if (!detail) return <p className={className}>{title}</p>;
  return (
    <details className="group">
      <summary className={`cursor-pointer list-none ${className ?? ""}`}>
        <span className="font-medium">{title}</span>{" "}
        <span className="text-xs text-brand-700 underline group-open:hidden">Ver qué incluye</span>
        <span className="hidden text-xs text-brand-700 underline group-open:inline">Ocultar</span>
      </summary>
      <p className="mt-1 text-xs text-muted">{detail}</p>
    </details>
  );
}
