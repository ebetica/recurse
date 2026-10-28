# Durable read images

pixel.jpg and pixel.webp are real one-pixel files encoded by the installed Photon
from the PNG used in durable_uploads.test.ts. pixel.gif is a one-pixel GIF89a.
The integration test reads each file through both Pi and Durable and compares
inline image bytes; PNG/BMP and oversized images are generated in the test.
