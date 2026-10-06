'use client';

import React, { useState, useEffect } from 'react';
import { Upload, Trash2, Film, Download, Play, RefreshCw, HardDrive, CheckCircle2, Link } from 'lucide-react';
import { MovieItem } from '../lib/types';

interface MovieLibraryProps {
  onSelectMovie: (filename: string) => void;
  currentMovie: string | null;
}

export const MovieLibrary: React.FC<MovieLibraryProps> = ({ onSelectMovie, currentMovie }) => {
  const [movies, setMovies] = useState<MovieItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);

  const fetchMovies = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/movies');
      const data = await res.json();
      if (Array.isArray(data)) {
        setMovies(data);
      }
    } catch (err) {
      console.error('Failed to fetch movies:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMovies();
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('video', file);

    setUploading(true);
    setUploadProgress(0);
    setUploadStatus(`Uploading ${file.name}...`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/movies/upload', true);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          setUploadProgress(percent);
        }
      };

      xhr.onload = () => {
        if (xhr.status === 200) {
          setUploadStatus('Upload complete!');
          fetchMovies();
          setTimeout(() => {
            setUploading(false);
            setUploadStatus(null);
            setUploadProgress(0);
          }, 2000);
        } else {
          setUploadStatus('Upload failed. Check file size or server.');
          setTimeout(() => setUploading(false), 3000);
        }
      };

      xhr.onerror = () => {
        setUploadStatus('Upload error. Network problem.');
        setTimeout(() => setUploading(false), 3000);
      };

      xhr.send(formData);
    } catch (err) {
      console.error('Upload exception:', err);
      setUploading(false);
    }
  };

  const handleCustomUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customUrl.trim()) return;
    
    try {
      const filename = prompt("Enter a title for this movie link:") || "Cloud Movie";
      await fetch('/api/movies/cloud', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: customUrl.trim(), filename })
      });
      fetchMovies();
      setCustomUrl('');
      setShowUrlInput(false);
    } catch (err) {
      console.error('Failed to add cloud link:', err);
    }
  };

  const handleDelete = async (filename: string) => {
    if (!confirm(`Are you sure you want to delete "${filename}"? This will free space on your PC.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/movies/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        fetchMovies();
      } else {
        alert('Failed to delete movie');
      }
    } catch (err) {
      console.error('Delete error:', err);
    }
  };

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 shadow-xl">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4 pb-3 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <Film className="w-5 h-5 text-rose-500" />
          <h2 className="font-bold text-white text-base">Movie Library</h2>
          <span className="text-xs text-neutral-400">({movies.length} available)</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowUrlInput(!showUrlInput)}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-lg text-xs font-semibold transition-all border border-neutral-700"
            title="Stream direct video URL (e.g. Cloudflare R2 / S3 / Direct link)"
          >
            <Link className="w-3.5 h-3.5 text-blue-400" />
            <span>Stream Link</span>
          </button>

          <button
            onClick={fetchMovies}
            className="p-1.5 hover:bg-neutral-800 rounded-lg text-neutral-400 hover:text-white transition-colors"
            title="Refresh library"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

        </div>
      </div>

      {/* Direct Video URL Input Box */}
      {showUrlInput && (
        <form onSubmit={handleCustomUrlSubmit} className="mb-4 flex gap-2">
          <input
            type="url"
            required
            placeholder="Paste direct .mp4 or stream URL (e.g. https://domain.com/video.mp4)"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            className="flex-1 px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500"
          />
          <button
            type="submit"
            className="px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold transition-colors flex items-center gap-1"
          >
            <Link className="w-3.5 h-3.5" />
            <span>Add Link</span>
          </button>
        </form>
      )}

      {/* Upload Progress Bar (Commented out as Upload is disabled) */}
      {/* 
      {uploading && (
        <div className="mb-4 bg-neutral-800/80 p-3 rounded-xl border border-rose-500/30">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-neutral-300 font-medium">{uploadStatus}</span>
            <span className="text-rose-400 font-bold">{uploadProgress}%</span>
          </div>
          <div className="w-full bg-neutral-700 rounded-full h-2 overflow-hidden">
            <div
              className="bg-rose-500 h-full rounded-full transition-all duration-200"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}
      */}

      {/* Movie List */}
      {movies.length === 0 ? (
        <div className="text-center py-8 text-neutral-500 text-xs">
          <HardDrive className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p>No movies added yet.</p>
          <p className="mt-1 text-neutral-600">
            Click "Add URL" to stream a video directly, or select a local file from the video player above!
          </p>
        </div>
      ) : (
        <div className="grid gap-2 max-h-72 overflow-y-auto pr-1">
          {movies.map((movie) => {
            const movieKey = movie.url || movie.filename;
            const isSelected = currentMovie === movieKey;
            return (
              <div
                key={movie.filename}
                className={`flex flex-col sm:flex-row sm:items-center justify-between p-2.5 rounded-lg border transition-all gap-2 ${
                  isSelected
                    ? 'bg-rose-950/30 border-rose-600/60'
                    : 'bg-neutral-800/50 hover:bg-neutral-800 border-neutral-700/60'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Film className={`w-4 h-4 shrink-0 ${isSelected ? 'text-rose-400' : 'text-neutral-400'}`} />
                  <div className="truncate">
                    <p className={`text-xs font-semibold truncate ${isSelected ? 'text-rose-300' : 'text-white'}`}>
                      {movie.filename}
                    </p>
                    <p className="text-[10px] text-neutral-400">
                      {movie.formattedSize}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 self-end sm:self-center shrink-0">
                  {/* Select to Watch */}
                  <button
                    onClick={() => onSelectMovie(movieKey)}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                      isSelected
                        ? 'bg-rose-600 text-white'
                        : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
                    }`}
                    title="Load this movie in the room for both users"
                  >
                    {isSelected ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    <span>{isSelected ? 'Playing' : 'Watch'}</span>
                  </button>

                  {/* Pre-download button for Slow Internet / Zero Buffering */}
                  {movie.isCloud ? (
                    <a
                      href={movie.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      download
                      className="flex items-center gap-1 px-2 py-1 bg-neutral-700/60 hover:bg-neutral-600 text-neutral-300 rounded-md text-xs transition-colors"
                      title="Download direct cloud link"
                    >
                      <Download className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="hidden sm:inline">Save</span>
                    </a>
                  ) : (
                    <a
                      href={`/api/movies/download/${encodeURIComponent(movie.filename)}`}
                      download={movie.filename}
                      className="flex items-center gap-1 px-2 py-1 bg-neutral-700/60 hover:bg-neutral-600 text-neutral-300 rounded-md text-xs transition-colors"
                      title="Download to phone/device for 100% Zero-Buffering offline sync"
                    >
                      <Download className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="hidden sm:inline">Save</span>
                    </a>
                  )}

                  {/* Delete Button to Free PC Storage */}
                  <button
                    onClick={() => handleDelete(movie.filename)}
                    className="p-1.5 text-neutral-400 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
                    title="Delete movie to free disk space on PC"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
