export interface FloatingMenuPoint {
  x: number;
  y: number;
}

export interface FloatingMenuSize {
  width: number;
  height: number;
}

export interface FloatingViewport {
  width: number;
  height: number;
}

export interface FloatingMenuPosition {
  left: number;
  top: number;
}

export function clampFloatingMenuPosition(
  point: FloatingMenuPoint,
  menu: FloatingMenuSize,
  viewport: FloatingViewport,
  gutter = 8,
): FloatingMenuPosition {
  const maxLeft = Math.max(gutter, viewport.width - menu.width - gutter);
  const maxTop = Math.max(gutter, viewport.height - menu.height - gutter);
  return {
    left: Math.min(Math.max(gutter, point.x), maxLeft),
    top: Math.min(Math.max(gutter, point.y), maxTop),
  };
}
