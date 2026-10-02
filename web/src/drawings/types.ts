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

export type LineStyleType = "solid" | "dashed" | "dotted";

export interface DrawingStyleProps {
  color?: string;
  lineWidth?: number;
  lineStyle?: LineStyleType;
}

export interface TrendlineDrawing extends DrawingStyleProps {
  id: string;
  type: "trendline";
  p1: Point;
  p2: Point;
  ray?: boolean;
  extendLeft?: boolean;
  extendRight?: boolean;
}

export interface RayDrawing extends DrawingStyleProps {
  id: string;
  type: "ray";
  p1: Point;
  p2: Point;
}

export interface HorizontalDrawing extends DrawingStyleProps {
  id: string;
  type: "horizontal";
  price: number;
  time?: number;
  showPrice?: boolean;
}

export interface VerticalDrawing extends DrawingStyleProps {
  id: string;
  type: "vertical";
  time: number;
  showTime?: boolean;
}

export interface ArrowDrawing extends DrawingStyleProps {
  id: string;
  type: "arrow";
  p1: Point;
  p2: Point;
}

export interface BoxZoneDrawing extends DrawingStyleProps {
  id: string;
  type: "box_zone";
  p1: Point;
  p2: Point;
  label?: string;
  fillColor?: string;
}

export interface FibonacciDrawing extends DrawingStyleProps {
  id: string;
  type: "fibonacci";
  p1: Point;
  p2: Point;
  extendLines?: boolean;
  extendLeft?: boolean;
  extendRight?: boolean;
}

export interface PositionDrawing {
  id: string;
  type: "position";
  side: "long" | "short";
  entry: Point;
  targetPrice: number;
  stopPrice: number;
  endTime: number;
  color?: string;
  targetColor?: string;
  stopColor?: string;
}

export interface MeasureDrawing extends DrawingStyleProps {
  id: string;
  type: "measure";
  p1: Point;
  p2: Point;
  fillColor?: string;
}

export interface TextDrawing {
  id: string;
  type: "text";
  p1: Point;
  text: string;
  color?: string;
  fontSize?: number;
  backgroundColor?: string;
  borderColor?: string;
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
  getBarCount?(t1: number, t2: number): number | null;
  getRangeVolume?(t1: number, t2: number): number | null;
}


