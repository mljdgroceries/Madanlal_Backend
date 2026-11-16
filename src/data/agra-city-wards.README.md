# Agra city address boundary

`agra-city-wards.json` is the union-by-membership of 100 Agra Nagar Nigam ward polygons from Saket Choudhary's BharatViz city ward boundary dataset. Original geometry and properties are retained.

Source: https://gist.github.com/saketkc/b73816205abb1eaa2fd02af858096295
Pinned revision: bd976a8e7a811106b90890c09d4457e5236718a7
Retrieved: 2026-09-22.

This is a public ward-data snapshot, not a verified current official municipal survey. City membership follows these polygons; municipal expansions or corrections require replacing this dataset. It does not represent the whole Agra district, a radius, a bounding box, or postal-code membership. Points on polygon edges are accepted; holes are excluded. There is no runtime geocoding/network dependency.

Address add/edit uses this boundary independently of warehouse location and pricing ranges. Cart/checkout still computes distance from the active default warehouse and applies the configured pricing bands; this address-only change does not define new prices beyond the last band.
