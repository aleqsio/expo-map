// What to call a screen on the map.
//
// Not every framework gives every screen a URL: a react-navigation screen that
// is registered on a navigator but absent from the linking config has no path
// at all. `title` is the producer's own label and is always present in bundles
// packed after the route-provider split; the fallbacks keep older bundles
// rendering exactly as they did before.
export const nodeLabel = (n, fallback = '?') => n?.title ?? n?.urlPath ?? n?.id ?? fallback
