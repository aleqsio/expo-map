import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// fs/path/crypto are referenced by opencv-js's UMD wrapper for its Node code
// paths; alias them to an empty shim so the browser build's OpenCV chunk stays
// importable (otherwise visualDiff degrades to its per-pixel fallback).
const nodeShim = path.resolve(import.meta.dirname, 'src/lib/nodeShim.js')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { fs: nodeShim, path: nodeShim, crypto: nodeShim },
  },
})
