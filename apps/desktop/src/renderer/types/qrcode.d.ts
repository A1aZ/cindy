declare module 'qrcode' {
  interface QRCodeOptions {
    margin?: number;
    width?: number;
    color?: {
      dark?: string;
      light?: string;
    };
  }

  export function toDataURL(text: string, options: QRCodeOptions): Promise<string>;
}
