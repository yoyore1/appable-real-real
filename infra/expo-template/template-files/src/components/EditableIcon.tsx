import Ionicons from "@expo/vector-icons/Ionicons";
import { registerElement, unregisterElement, useEditableValue, type OverrideValue } from "../lib/tapEdit";
import { useEffect } from "react";

export type EditableIconProps = React.ComponentProps<typeof Ionicons> & {
  /** Unique id used by tap-to-edit. */
  testID: string;
  /** Source of truth in generated code. */
  source: { file: string; export: string; property?: string };
  /** Default icon display value (color is the main editable property here). */
  defaultValue: OverrideValue;
};

/**
 * Template component for any user-editable icon color.
 *
 * Usage:
 *   <EditableIcon
 *     testID="home-add-icon"
 *     name="add"
 *     size={24}
 *     source={{ file: "src/lib/tokens.ts", export: "colors", property: "primary" }}
 *     defaultValue={{ color: colors.primary as string }}
 *   />
 */
export function EditableIcon({
  testID,
  source,
  defaultValue,
  color,
  style,
  ...rest
}: EditableIconProps) {
  useEffect(() => {
    registerElement(testID, { testID, source, defaultValue });
    return () => unregisterElement(testID);
  }, [testID]);

  const value = useEditableValue(testID, defaultValue);

  return (
    <Ionicons
      testID={testID}
      color={value.color ?? color}
      style={style}
      {...rest}
    />
  );
}
