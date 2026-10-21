import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatBs, formatDate, formatFolio } from "../format";
import type { QuoteDetail } from "../quotes";
import type { BrandForText } from "../whatsapp-text";

const colors = { primary: "#0f766e", text: "#1f2933", muted: "#61707d", line: "#d9e2e8", band: "#f1f6f8" };

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 56, paddingHorizontal: 44, fontSize: 10, color: colors.text, fontFamily: "Helvetica" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22 },
  logo: { width: 150, height: 48, objectFit: "contain" },
  wordmark: { fontSize: 22, fontFamily: "Helvetica-Bold", color: colors.primary },
  titleBlock: { alignItems: "flex-end" },
  title: { fontSize: 15, fontFamily: "Helvetica-Bold" },
  folio: { fontSize: 11, color: colors.primary, marginTop: 3, fontFamily: "Helvetica-Bold" },
  meta: { flexDirection: "row", flexWrap: "wrap", backgroundColor: colors.band, borderRadius: 4, padding: 10, marginBottom: 18 },
  metaItem: { width: "50%", marginBottom: 4 },
  metaLabel: { color: colors.muted, fontSize: 8, textTransform: "uppercase" },
  metaValue: { fontSize: 10, marginTop: 1 },
  tableHeader: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.text, paddingBottom: 5, marginBottom: 2 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: colors.line, paddingVertical: 6 },
  colNum: { width: 22, color: colors.muted },
  colName: { flex: 1, paddingRight: 8 },
  colSample: { width: 110, color: colors.muted },
  colPrice: { width: 80, textAlign: "right" },
  th: { fontFamily: "Helvetica-Bold", fontSize: 8, textTransform: "uppercase", color: colors.muted },
  code: { fontSize: 8, color: colors.muted, marginTop: 1 },
  totalRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 12 },
  totalLabel: { fontSize: 12, fontFamily: "Helvetica-Bold", marginRight: 16 },
  totalValue: { fontSize: 14, fontFamily: "Helvetica-Bold", color: colors.primary, width: 120, textAlign: "right" },
  note: { marginTop: 24, fontSize: 9, color: colors.muted, lineHeight: 1.4 },
  footer: { position: "absolute", bottom: 24, left: 44, right: 44, borderTopWidth: 0.5, borderTopColor: colors.line, paddingTop: 8, fontSize: 8, color: colors.muted, textAlign: "center" }
});

export function QuotePdf({ quote, brand, logo }: { quote: QuoteDetail; brand: BrandForText; logo?: Buffer }) {
  const contact = [brand.address, brand.hours, brand.phone].filter(Boolean).join("  ·  ");
  return (
    <Document title={`Cotización ${formatFolio(quote.folio)}`} author={brand.name} language="es">
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          {logo ? <Image src={logo} style={styles.logo} /> : <Text style={styles.wordmark}>{brand.name}</Text>}
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Cotización de laboratorio</Text>
            <Text style={styles.folio}>N° {formatFolio(quote.folio)}</Text>
          </View>
        </View>

        <View style={styles.meta}>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Paciente</Text>
            <Text style={styles.metaValue}>{quote.patientName ?? "—"}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Fecha</Text>
            <Text style={styles.metaValue}>{formatDate(quote.createdAt)}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Solicitado por</Text>
            <Text style={styles.metaValue}>{[quote.createdByName, quote.organizationName].filter(Boolean).join(" · ") || "—"}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Válida hasta</Text>
            <Text style={styles.metaValue}>{formatDate(quote.validUntil)}</Text>
          </View>
        </View>

        <View style={styles.tableHeader} fixed>
          <Text style={[styles.colNum, styles.th]}>#</Text>
          <Text style={[styles.colName, styles.th]}>Estudio</Text>
          <Text style={[styles.colSample, styles.th]}>Muestra</Text>
          <Text style={[styles.colPrice, styles.th]}>Precio</Text>
        </View>
        {quote.items.map((item, index) => (
          <View key={item.labTestId} style={styles.row} wrap={false}>
            <Text style={styles.colNum}>{index + 1}</Text>
            <View style={styles.colName}>
              <Text>{item.name}</Text>
              {item.code ? <Text style={styles.code}>Cód. {item.code}</Text> : null}
            </View>
            <Text style={styles.colSample}>{item.sampleType ?? ""}</Text>
            <Text style={styles.colPrice}>{formatBs(item.priceBs)}</Text>
          </View>
        ))}

        <View style={styles.totalRow} wrap={false}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>{formatBs(quote.totalBs)}</Text>
        </View>

        <Text style={styles.note}>
          Precios en bolivianos, tarifa {quote.tariffName}. Cotización válida hasta el {formatDate(quote.validUntil)}.
          {brand.footerNote ? `\n${brand.footerNote}` : ""}
        </Text>

        <Text style={styles.footer} fixed>
          {contact ? `${brand.name}  ·  ${contact}` : brand.name}
        </Text>
      </Page>
    </Document>
  );
}
