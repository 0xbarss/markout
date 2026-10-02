export interface Point {
  time: number;
  price: number;
}

export type DrawingTool =
  | "cursor"
  | "trendline"
  | "ray"
  | "horizontal"
  | "vertical"
  | "arrow"
  | "box_zone"
  | "fibonacci"
  | "position"
  | "measure"
  | "text";

export interface TrendlineDrawing {
  id: string;
  type: "trendline";
  p1: Point;
  p2: Point;
  ray?: boolean;
}

export interface RayDrawing {
  id: string;
  type: "ray";
  p1: Point;
  p2: Point;
}

export interface HorizontalDrawing {
  id: string;
  type: "horizontal";
  price: number;
  time?: number;
}

export interface VerticalDrawing {
  id: string;
  type: "vertical";
  time: number;
}

export interface ArrowDrawing {
  id: string;
  type: "arrow";
  p1: Point;
  p2: Point;
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

export interface TextDrawing {
  id: string;
  type: "text";
  p1: Point;
  text: string;
}

export type Drawing =
  | TrendlineDrawing
  | RayDrawing
  | HorizontalDrawing
  | VerticalDrawing
  | ArrowDrawing
  | BoxZoneDrawing
  | FibonacciDrawing
  | PositionDrawing
  | MeasureDrawing
  | TextDrawing;


export interface CoordinateConverter {
  timeToX(time: number): number | null;
  xToTime(x: number): number | null;
  priceToY(price: number): number | null;
  yToPrice(y: number): number | null;
  snapPoint?(x: number, y: number): Point | null;
}
