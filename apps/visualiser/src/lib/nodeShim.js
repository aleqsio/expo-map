// Empty stand-in for Node built-ins (fs/path/crypto) referenced by
// @techstark/opencv-js's UMD wrapper. Those code paths only run under Node;
// in the browser they must resolve to *something* or the whole chunk fails
// to import and the visual diff silently degrades to its per-pixel fallback.
export default {}
