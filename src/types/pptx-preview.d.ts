// pptx-preview ships no TypeScript types.
declare module "pptx-preview" {
  export interface PptxViewer {
    preview(data: ArrayBuffer | Uint8Array): Promise<unknown> | unknown;
  }
  export function init(container: HTMLElement): PptxViewer;
  const _default: { init: typeof init };
  export default _default;
}
