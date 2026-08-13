import { OverlayFrame, type OverlayFrameProps } from "./Sheet";

export type DialogFrameProps = OverlayFrameProps;

export function DialogFrame(props: DialogFrameProps) {
  return <OverlayFrame {...props} variant="dialog" />;
}
