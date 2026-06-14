import { View, type ViewProps } from "react-native";
import { registerElement, unregisterElement, useEditableValue, type OverrideValue } from "../lib/tapEdit";
import { useEffect } from "react";

export type EditableBackgroundProps = ViewProps & {
  /** Unique id used by tap-to-edit. */
  testID: string;
  /** Source of truth in generated code. */
  source: { file: string; export: string; property?: string };
  /** Default background display value. */
  defaultValue: OverrideValue;
};

/**
 * Template wrapper for any container whose background color should be editable.
 *
 * Usage:
 *   <EditableBackground
 *     testID="home-header-bg"
 *     source={{ file: "src/lib/tokens.ts", export: "colors", property: "background" }}
 *     defaultValue={{ backgroundColor: colors.background as string }}
 *     style={styles.header}
 *   >
 *     {children}
 *   </EditableBackground>
 */
export function EditableBackground({
  testID,
  source,
  defaultValue,
  style,
  children,
  ...rest
}: EditableBackgroundProps) {
  useEffect(() => {
    registerElement(testID, { testID, source, defaultValue });
    return () => unregisterElement(testID);
  }, [testID]);

  const value = useEditableValue(testID, defaultValue);

  return (
    <View
      testID={testID}
      style={[
        style,
        value.backgroundColor ? { backgroundColor: value.backgroundColor } : null,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}
