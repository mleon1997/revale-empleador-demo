// Presentation fixtures for Andrea's demo only. Financial records and merchant
// identifiers remain unchanged; other employees always see their actual data.
const PREVIEW_MERCHANT_ID = "merchant_cebiches_ruminahui";
const BOGO_LOGO = "https://mi.revale.app/empleados/bogo-brand.png";

export function isAndreaDemo(principal) {
  return principal?.personId === "person_demo_andrea"
    && principal?.email === "andrea.demo@revale.app";
}

export function employeeMerchantPresentation(principal, merchant) {
  if (!isAndreaDemo(principal) || merchant?.id !== PREVIEW_MERCHANT_ID) return merchant;
  const result = {
    ...merchant,
    name: "BOGÖ",
    slug: "bogo",
    logoUrl: BOGO_LOGO,
    brandPrimary: "#2B1C14"
  };
  if (Array.isArray(merchant.locations)) {
    result.locations = merchant.locations.slice(0, 1).map(location => ({ ...location, name: "Tumbaco" }));
  }
  if ("locationName" in merchant) result.locationName = "Tumbaco";
  return result;
}

export function employeeActivityPresentation(principal, rows) {
  return rows.map(({ merchant_id, ...entry }) => {
    if (!isAndreaDemo(principal) || merchant_id !== PREVIEW_MERCHANT_ID) return entry;
    return {
      ...entry,
      merchant_name: "BOGÖ",
      location_name: "Tumbaco",
      logo_url: BOGO_LOGO,
      description: (entry.entry_type === "reversal" ? "Devolución" : "Consumo") + " ReVale - BOGÖ · Tumbaco"
    };
  });
}
