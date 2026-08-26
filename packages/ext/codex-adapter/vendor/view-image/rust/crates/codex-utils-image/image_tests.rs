use std::io::Cursor;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use image::codecs::gif::GifEncoder;
use image::{DynamicImage, Frame, ImageBuffer, ImageFormat, Rgba};

use super::{ImageProcessingError, MAX_IMAGE_DIMENSION, load_image_bytes};

fn fixture(format: ImageFormat) -> Vec<u8> {
    let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 1, Rgba([1, 2, 3, 255])));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, format).expect("encode fixture");
    bytes.into_inner()
}

fn data_url_parts(url: String) -> (String, Vec<u8>) {
    let (header, encoded) = url.split_once(',').expect("data URL separator");
    (
        header.to_string(),
        BASE64_STANDARD.decode(encoded).expect("base64 image"),
    )
}

fn one_pixel_bmp() -> Vec<u8> {
    vec![
        0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 0x28, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0,
        0, 1, 0, 0x18, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0x13, 0x0b, 0, 0, 0x13, 0x0b, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0xff, 0,
    ]
}

#[test]
fn preserves_valid_png_jpeg_and_webp_bytes() {
    for (format, mime) in [
        (ImageFormat::Png, "image/png"),
        (ImageFormat::Jpeg, "image/jpeg"),
        (ImageFormat::WebP, "image/webp"),
    ] {
        let original = fixture(format);
        // Deliberately use an extension that does not identify the content.
        let image = load_image_bytes(Path::new("fixture.unknown"), original.clone())
            .expect("validate supported image");
        let (header, decoded) = data_url_parts(image.into_data_url());
        assert_eq!(header, format!("data:{mime};base64"));
        assert_eq!(decoded, original);
    }
}

#[test]
fn converts_a_non_animated_gif_to_png() {
    let image = load_image_bytes(Path::new("still.gif"), fixture(ImageFormat::Gif))
        .expect("convert GIF still");
    let (header, decoded) = data_url_parts(image.into_data_url());
    assert_eq!(header, "data:image/png;base64");
    assert_eq!(
        image::guess_format(&decoded).expect("detect converted GIF output"),
        ImageFormat::Png
    );
}

#[test]
fn rejects_animated_gifs() {
    let mut bytes = Vec::new();
    GifEncoder::new(&mut bytes)
        .encode_frames([
            Frame::new(ImageBuffer::from_pixel(1, 1, Rgba([1, 2, 3, 255]))),
            Frame::new(ImageBuffer::from_pixel(1, 1, Rgba([4, 5, 6, 255]))),
        ])
        .expect("encode animated GIF fixture");

    let error = load_image_bytes(Path::new("animated.gif"), bytes)
        .expect_err("animated GIF must not be reduced to one frame");
    assert!(matches!(error, ImageProcessingError::AnimatedGif));
}

#[test]
fn rejects_images_above_the_decode_dimension_limit() {
    let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(
        MAX_IMAGE_DIMENSION + 1,
        1,
        Rgba([1, 2, 3, 255]),
    ));
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, ImageFormat::Png)
        .expect("encode oversized-dimension fixture");

    let error = load_image_bytes(Path::new("too-wide.png"), bytes.into_inner())
        .expect_err("oversized image dimensions must be bounded");
    assert!(matches!(error, ImageProcessingError::Decode { .. }));
}

#[test]
fn rejects_malformed_and_unsupported_bytes() {
    let malformed = load_image_bytes(Path::new("not-an-image.txt"), b"plain text".to_vec())
        .expect_err("text must not be reinterpreted");
    assert!(matches!(malformed, ImageProcessingError::Decode { .. }));

    let bmp = load_image_bytes(Path::new("fixture.png"), one_pixel_bmp())
        .expect_err("BMP is outside the retained prompt-image formats");
    assert!(matches!(
        bmp,
        ImageProcessingError::UnsupportedImageFormat {
            format: ImageFormat::Bmp
        }
    ));
}
