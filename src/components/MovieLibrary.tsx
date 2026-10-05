'use client';

import React, { useState, useEffect } from 'react';
import { Upload, Trash2, Film, Download, Play, RefreshCw, HardDrive, CheckCircle2 } from 'lucide-react';
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
      // Use XMLHttpRequest to track upload progress accurately
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
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <Film className="w-5 h-5 text-rose-500" />
          <h2 className="font-bold text-white text-base">Movie Library</h2>
          <span className="text-xs text-neutral-400">({movies.length} available)</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchMovies}
            className="p-1.5 hover:bg-neutral-800 rounded-lg text-neutral-400 hover:text-white transition-colors"
            title="Refresh library"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {/* Upload Button */}
          <label className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-500 active:scale-95 text-white rounded-lg text-xs font-semibold cursor-pointer transition-all shadow-md shadow-rose-950">
            <Upload className="w-3.5 h-3.5" />
            <span>Upload Movie</span>
            <input
              type="file"
              accept="video/*,.mkv,.mp4,.webm,.mov"
              onChange={handleFileUpload}
              disabled={uploading}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {/* Upload Progress Bar */}
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

      {/* Movie List */}
      {movies.length === 0 ? (
        <div className="text-center py-8 text-neutral-500 text-xs">
          <HardDrive className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p>No movies uploaded yet.</p>
          <p className="mt-1 text-neutral-600">
            Upload an .mp4 or .mkv movie above to start watching together!
          </p>
        </div>
      ) : (
        <div className="grid gap-2 max-h-72 overflow-y-auto pr-1">
          {movies.map((movie) => {
            const isSelected = currentMovie === movie.filename;
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
                    onClick={() => onSelectMovie(movie.filename)}
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
                  <a
                    href={`/api/movies/download/${encodeURIComponent(movie.filename)}`}
                    download={movie.filename}
                    className="flex items-center gap-1 px-2 py-1 bg-neutral-700/60 hover:bg-neutral-600 text-neutral-300 rounded-md text-xs transition-colors"
                    title="Download to phone/device for 100% Zero-Buffering offline sync"
                  >
                    <Download className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="hidden sm:inline">Save</span>
                  </a>

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
