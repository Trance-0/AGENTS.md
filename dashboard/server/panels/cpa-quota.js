export function createCpaQuotaPanel() {
  return { id: "cpa-quota", title: "CPA quota", adminOnly: true, icon: "chart", description: "Remaining capacity and reset windows from the CPA remote dashboard. Management credentials are encrypted at rest." };
}
