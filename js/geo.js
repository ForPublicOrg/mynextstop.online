// Browser geolocation with a friendly failure path.
export function locate() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new Error('unsupported')); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => reject(err),
      { enableHighAccuracy: false, timeout: 9000, maximumAge: 300000 }
    );
  });
}

// India-ish bounding box sanity (a VPN or desktop IP can put people anywhere)
export function inIndia({ lat, lng }) {
  return lat > 6 && lat < 37.5 && lng > 68 && lng < 97.5;
}
