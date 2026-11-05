import { type ReactNode, useEffect, useRef, useState } from "react";
import { Keyboard, Platform, ScrollView, type StyleProp, View, type ViewStyle } from "react-native";

/**
 * Keeps its content above the software keyboard.
 *
 * Android draws edge to edge, so the window no longer shrinks for the keyboard,
 * and the height of the navigation chrome above a screen varies. Measuring how
 * far the keyboard reaches into this view works for both, on both platforms.
 */
export function KeyboardAware({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const view = useRef<View>(null);
  const [overlap, setOverlap] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const shown = Keyboard.addListener(showEvent, (event) => {
      view.current?.measureInWindow((_x, y, _width, height) => {
        setOverlap(Math.max(0, y + height - event.endCoordinates.screenY));
      });
    });
    const hidden = Keyboard.addListener(hideEvent, () => {
      setOverlap(0);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  return (
    <View ref={view} style={[{ flex: 1 }, style, { paddingBottom: overlap }]}>
      {children}
    </View>
  );
}

/** A form that stays reachable, and scrollable, when the keyboard takes half the screen. */
export function KeyboardForm({
  children,
  style,
  contentStyle,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <KeyboardAware style={style}>
      <ScrollView
        contentContainerStyle={[{ flexGrow: 1 }, contentStyle]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {children}
      </ScrollView>
    </KeyboardAware>
  );
}
