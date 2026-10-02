export interface Point {
  time: number;
  price: number;
}

export type DrawingTool =
  | "cursor"
  | "trendline"
  | "horizontal"
  | "box_zone"
  | "fibonacci"
  | "position"
  | "measure";

export interface TrendlineDrawing {
  id: string;
  type: "trendline";
  p1: Point;
  p2: Point;
  ray?: boolean;
}

export interface HorizontalDrawing {
  id: string;
  type: "horizontal";
  price: number;
  time?: number;
}

export interface BoxZoneDrawing {
  id: string;
  type: "box_zone";
  p1: Point;
  p2: Point;
  label?: string;
}

export interface FibonacciDrawing {
  id: string;
  type: "fibonacci";
  p1: Point;
  p2: Point;
}

export interface PositionDrawing {
  id: string;
  type: "position";
  side: "long" | "short";
  entry: Point;
  targetPrice: number;
  stopPrice: number;
  endTime: number;
}

export interface MeasureDrawing {
  id: string;
  type: "measure";
  p1: Point;
  p2: Point;
}

export type Drawing =
  | TrendlineDrawing
  | HorizontalDrawing
  | BoxZoneDrawing
  | FibonacciDrawing
  | PositionDrawing
  | MeasureDrawing;

export interface CoordinateConverter {
  timeToX(time: number): number | null;
  xToTime(x: number): number | null;
  priceToY(price: number): number | null;
  yToPrice(y: number): number | null;
  snapPoint?(x: number, y: number): Point | null;
}
