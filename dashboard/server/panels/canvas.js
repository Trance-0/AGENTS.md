export function createCanvasPanel() {
  return { id: 'canvas-settings', title: 'Canvas', icon: 'panel', group: 'canvas', order: 0, adminOnly: true,
    description: 'Edit widget layout, avatar states and backdrop appearance.',
    tabs: [{ id: 'canvas-layout', title: 'Layout' }, { id: 'avatar-library', title: 'Avatars' }], settings: () => [], status: () => [] };
}
