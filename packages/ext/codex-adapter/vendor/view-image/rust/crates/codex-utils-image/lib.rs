//! Local image validation and conversion retained from OpenAI Codex.
//!
//! The upstream shared crate also handles data URLs, resizing policies, and a
//! process-wide cache. This adapter-owned helper needs only local file bytes in
//! original mode, so those unrelated APIs and dependencies are intentionally
//! omitted.

use std::io::Cursor;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use image::AnimationDecoder;
use image::DynamicImage;
use image::ImageDecoder;
use image::ImageFormat;
use image::ImageReader;
use image::Limits;
use image::codecs::gif::GifDecoder;

const MAX_IMAGE_DIMENSION: u32 = 4096;
const MAX_DECODED_IMAGE_BYTES: u64 = 128 * 1024 * 1024;

pub mod error;

pub use crate::error::ImageProcessingError;

#[derive(Debug)]
pub struct EncodedImage {
    bytes: Vec<u8>,
    mime: &'static str,
}

impl EncodedImage {
    #[must_use]
    pub fn into_data_url(self) -> String {
        format!(
            "data:{};base64,{}",
            self.mime,
            BASE64_STANDARD.encode(self.bytes)
        )
    }
}

/// Validates supported local image bytes and returns a model-safe representation.
///
/// PNG, JPEG, and WebP bytes are preserved after a successful full decode, which
/// also preserves their safe color/orientation metadata. A single-frame GIF is
/// decoded and encoded as PNG because GIF is not a supported Pi image block MIME
/// type. Animated GIFs are rejected instead of silently discarding their frames.
pub fn load_image_bytes(
    path: &Path,
    file_bytes: Vec<u8>,
) -> Result<EncodedImage, ImageProcessingError> {
    let format = image::guess_format(&file_bytes)
        .map_err(|source| ImageProcessingError::decode(path, source))?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
    ) {
        return Err(ImageProcessingError::UnsupportedImageFormat { format });
    }

    match format {
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP => {
            decode_still(path, &file_bytes, format)?;
            Ok(EncodedImage {
                bytes: file_bytes,
                mime: match format {
                    ImageFormat::Png => "image/png",
                    ImageFormat::Jpeg => "image/jpeg",
                    ImageFormat::WebP => "image/webp",
                    _ => unreachable!("still image formats were checked above"),
                },
            })
        }
        ImageFormat::Gif => decode_gif_still(path, &file_bytes).and_then(encode_png),
        _ => unreachable!("supported image formats were checked above"),
    }
}

fn decoding_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODED_IMAGE_BYTES);
    limits
}

fn decode_still(
    path: &Path,
    file_bytes: &[u8],
    format: ImageFormat,
) -> Result<DynamicImage, ImageProcessingError> {
    let mut reader = ImageReader::with_format(Cursor::new(file_bytes), format);
    reader.limits(decoding_limits());
    reader
        .decode()
        .map_err(|source| ImageProcessingError::decode(path, source))
}

fn decode_gif_still(path: &Path, file_bytes: &[u8]) -> Result<DynamicImage, ImageProcessingError> {
    let mut decoder = GifDecoder::new(Cursor::new(file_bytes))
        .map_err(|source| ImageProcessingError::decode(path, source))?;
    decoder
        .set_limits(decoding_limits())
        .map_err(|source| ImageProcessingError::decode(path, source))?;
    let mut frames = decoder.into_frames();
    let first = frames
        .next()
        .transpose()
        .map_err(|source| ImageProcessingError::decode(path, source))?
        .ok_or_else(|| {
            ImageProcessingError::decode(
                path,
                image::ImageError::IoError(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "GIF image contains no frames",
                )),
            )
        })?;
    if frames
        .next()
        .transpose()
        .map_err(|source| ImageProcessingError::decode(path, source))?
        .is_some()
    {
        return Err(ImageProcessingError::AnimatedGif);
    }
    Ok(DynamicImage::ImageRgba8(first.into_buffer()))
}

fn encode_png(image: DynamicImage) -> Result<EncodedImage, ImageProcessingError> {
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(ImageProcessingError::Encode)?;
    Ok(EncodedImage {
        bytes: output.into_inner(),
        mime: "image/png",
    })
}

#[cfg(test)]
#[path = "image_tests.rs"]
mod tests;
