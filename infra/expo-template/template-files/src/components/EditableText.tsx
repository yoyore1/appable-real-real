import { Text, type TextProps } from "react-native";
import { registerElement, unregisterElement, useEditableValue, type OverrideValue } from "../lib/tapEdit";
import { useEffect } from "react";

export type EditableTextProps = TextProps & {
  /** Unique id used by tap-to-edit. */
  testID: string;
  /** Source of truth in generated code (e.g. { file: "src/lib/strings.ts", export: "UI_STRINGS", property: "homeTitle" }). */
  source: { file: string; export: string; property?: string };
  /** The value that would render if no override existed. */
  defaultValue: OverrideValue & { text: string };
  children?: string;
};

/**
 * Template component for any user-editable text.
 *
 * Usage in generated screens:
 *   <EditableText
 *     testID="home-title"
 *     source={{ file: "src/lib/strings.ts", export: "UI_STRINGS", property: "homeTitle" }}
 *     defaultValue={{ text: UI_STRINGS.homeTitle, color: colors.primary as string }}
 *   />
 */
export function EditableText({
  testID,
  source,
  defaultValue,
  children,
  style,
  ...rest
}: EditableTextProps) {
  useEffect(() => {
    registerElement(testID, { testID, source, defaultValue });
    return () => unregisterElement(testID);
  }, [testID]);

  const value = useEditableValue(testID, defaultValue);

  return (
    <Text
      testID={testID}
      style={[
        style,
        value.color ? { color: value.color } : null,
        value.fontSize ? { fontSize: value.fontSize } : null,
        value.fontWeight ? { fontWeight: value.fontWeight } : null,
        value.fontFamily ? { fontFamily: value.fontFamily } : null,
      ]}
      {...rest}
    >
      {value.text ?? children ?? ""}
    </Text>
  );
}
