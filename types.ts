export enum GenerationStatus {
  IDLE = 'IDLE',
  GENERATING = 'GENERATING',
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR'
}

export interface GeneratedImage {
  url: string;
  timestamp: number;
}

export interface TryOnConfig {
  prompt: string;
  aspectRatio: string;
  imageSize: string;
}