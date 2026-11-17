import { Children, isValidElement, type ReactNode } from "react";
import { v3VisualSkinEnabled } from "../visualShellConfig";
import { Select } from "./Controls";

interface Props {
  value: string;
  label?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  disabled?: boolean;
  children: ReactNode;
  onValueChange: (value: string) => void;
}

/** Keep the existing option labels, values and disabled destinations in both skins. */
export function SelectField({ children, label, onValueChange, ...props }: Props) {
  if (!v3VisualSkinEnabled) {
    return <select {...props} onChange={event => onValueChange(event.currentTarget.value)}>{children}</select>;
  }
  const options = Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ children: ReactNode; value?: string; disabled?: boolean }>(child) || child.type !== "option") return [];
    const text = Children.toArray(child.props.children).join("");
    return [{ value: child.props.value ?? text, label: text, disabled: child.props.disabled }];
  });
  return <Select label={props["aria-label"] ?? label ?? ""} options={options} value={props.value}
    disabled={props.disabled} onChange={onValueChange} testId={props["data-testid"]} />;
}
