export function createCpaQuotaPanel() {
  return { id: "cpa-quota", title: "CPA quota", adminOnly: true, icon: "quota", group: "usage", order: 20, tabTitle: "CPA quota", description: "Remaining capacity and reset windows per CPA account. Management credentials are encrypted at rest." };
}
