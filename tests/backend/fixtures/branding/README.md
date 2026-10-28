# Branding fixture

`icon.png` is the real 32 px PNG favicon captured from `web/brand/favicon-32.png`
at commit `3d68d21f47394e2ac0ec9d3d0c314150539bccb2`. The branding integration test
pads these image bytes to the upload limit to exercise PNG handling on the real
HTTP and native-tool paths, without reading implementation files in tests.
