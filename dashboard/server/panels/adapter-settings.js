export function createAdapterSettingsPanel() {
  return { id: 'adapter-settings', title: 'Channel access', icon: 'bot', group: 'adapters', order: 5,
    adminOnly: true, description: 'AstrBot execution access for verified owners and selected groups.',
    tabs: [{ id: 'adapter-settings', title: 'Channel access' }], settings: () => [], status: () => [] };
}
