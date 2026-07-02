declare module 'tesseract.js' {
  export interface Bbox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }

  export interface Word {
    text: string;
    bbox: Bbox;
    confidence: number;
  }

  export interface RecognizeResult {
    data: {
      words: Word[];
      text: string;
    };
  }

  export interface WorkerOptions {
    workerPath?: string;
    langPath?: string;
    corePath?: string;
    logger?: (message: any) => void;
    errorHandler?: (error: Error) => void;
  }

  export function recognize(
    image: Buffer | string,
    lang: string,
    options?: WorkerOptions
  ): Promise<RecognizeResult>;

  export function createWorker(
    lang: string,
    oem?: number,
    options?: WorkerOptions
  ): Promise<any>;
}
