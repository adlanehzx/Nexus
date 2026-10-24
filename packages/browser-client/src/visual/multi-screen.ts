export interface DisplayScreen {
  id: string;
  name: string;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export class ScreenBoundaryViolationError extends Error {
  readonly code = "SCREEN_BOUNDARY_VIOLATION";
  constructor(message: string) {
    super(message);
    this.name = "ScreenBoundaryViolationError";
  }
}

export class MultiScreenManager {
  private screens = new Map<string, DisplayScreen>();

  constructor(initialScreens?: DisplayScreen[]) {
    if (initialScreens && initialScreens.length > 0) {
      for (const s of initialScreens) {
        this.screens.set(s.id, s);
      }
    } else {
      // Default primary screen
      this.screens.set("screen-primary", {
        id: "screen-primary",
        name: "Primary Display",
        width: 1920,
        height: 1080,
        scaleFactor: 1.0,
        isPrimary: true,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });
    }
  }

  registerScreen(screen: DisplayScreen): void {
    this.screens.set(screen.id, screen);
  }

  getScreens(): DisplayScreen[] {
    return Array.from(this.screens.values());
  }

  getScreen(screenId: string): DisplayScreen | undefined {
    return this.screens.get(screenId);
  }

  /**
   * Validates target coordinates and maps them taking into account DPI scale factor and screen bounds.
   * Throws ScreenBoundaryViolationError if coordinates are out of bounds.
   */
  mapCoordinates(
    screenId: string,
    rawCoords: { x: number; y: number },
  ): { targetX: number; targetY: number; screen: DisplayScreen } {
    const screen = this.screens.get(screenId);
    if (!screen) {
      throw new ScreenBoundaryViolationError(`Target screen '${screenId}' not found`);
    }

    if (
      rawCoords.x < 0 ||
      rawCoords.x > screen.width ||
      rawCoords.y < 0 ||
      rawCoords.y > screen.height
    ) {
      throw new ScreenBoundaryViolationError(
        `Target coordinate (${rawCoords.x}, ${rawCoords.y}) is out of bounds for screen ${screen.name} (${screen.width}x${screen.height})`,
      );
    }

    // Apply scaling factor to prevent coordinate drift across High-DPI screens
    const targetX = Math.round(rawCoords.x * screen.scaleFactor);
    const targetY = Math.round(rawCoords.y * screen.scaleFactor);

    return { targetX, targetY, screen };
  }
}
