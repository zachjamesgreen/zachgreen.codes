// unpdf's type declarations import two types from @napi-rs/canvas, an
// optional peer dependency it needs only to render pages as images. Nothing
// here renders, so it isn't installed, and these opaque stand-ins let tsc
// check the code that imports unpdf (tests/helpers/pdf-text.ts).
declare module "@napi-rs/canvas" {
  export interface Canvas {}
  export interface SKRSContext2D {}
}
