use std::path::{Path, PathBuf};

use image::{ImageError, ImageFormat};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ImageProcessingError {
    #[error("invalid or unsupported image at {path}: {source}")]
    Decode {
        path: PathBuf,
        #[source]
        source: ImageError,
    },
    #[error("unsupported image format {format:?}")]
    UnsupportedImageFormat { format: ImageFormat },
    #[error("animated GIF images are not supported")]
    AnimatedGif,
    #[error("failed to encode GIF still image as PNG: {0}")]
    Encode(#[source] ImageError),
}

impl ImageProcessingError {
    pub fn decode(path: &Path, source: ImageError) -> Self {
        Self::Decode {
            path: path.to_path_buf(),
            source,
        }
    }
}
