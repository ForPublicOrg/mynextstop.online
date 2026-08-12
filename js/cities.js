// Origin fallback: major Indian cities for "I'll type where I am".
// Destinations from the dataset are merged into this search at runtime.
export const CITIES = [
  ['Mumbai', 19.076, 72.877], ['Delhi', 28.614, 77.209], ['Bengaluru', 12.972, 77.594],
  ['Hyderabad', 17.385, 78.487], ['Chennai', 13.083, 80.270], ['Kolkata', 22.573, 88.364],
  ['Pune', 18.520, 73.857], ['Ahmedabad', 23.023, 72.571], ['Jaipur', 26.912, 75.787],
  ['Surat', 21.170, 72.831], ['Lucknow', 26.847, 80.946], ['Kanpur', 26.449, 80.331],
  ['Nagpur', 21.146, 79.088], ['Indore', 22.720, 75.858], ['Bhopal', 23.259, 77.413],
  ['Patna', 25.594, 85.138], ['Vadodara', 22.307, 73.181], ['Ludhiana', 30.901, 75.857],
  ['Agra', 27.177, 78.008], ['Nashik', 19.997, 73.790], ['Varanasi', 25.317, 82.973],
  ['Amritsar', 31.634, 74.872], ['Chandigarh', 30.733, 76.779], ['Coimbatore', 11.017, 76.956],
  ['Kochi', 9.932, 76.267], ['Thiruvananthapuram', 8.524, 76.936], ['Panaji (Goa)', 15.499, 73.827],
  ['Guwahati', 26.144, 91.736], ['Bhubaneswar', 20.296, 85.824], ['Visakhapatnam', 17.687, 83.219],
  ['Mysuru', 12.296, 76.639], ['Madurai', 9.925, 78.120], ['Jodhpur', 26.238, 73.024],
  ['Udaipur', 24.585, 73.712], ['Dehradun', 30.317, 78.032], ['Shimla', 31.104, 77.173],
  ['Srinagar', 34.084, 74.797], ['Leh', 34.152, 77.577], ['Ranchi', 23.344, 85.310],
  ['Raipur', 21.251, 81.630], ['Jabalpur', 23.182, 79.986], ['Gwalior', 26.218, 78.183],
  ['Jammu', 32.727, 74.857], ['Siliguri', 26.727, 88.395], ['Shillong', 25.579, 91.893],
  ['Imphal', 24.817, 93.937], ['Aizawl', 23.727, 92.718], ['Itanagar', 27.084, 93.605],
  ['Kohima', 25.675, 94.110], ['Agartala', 23.832, 91.286], ['Gangtok', 27.339, 88.607],
  ['Port Blair', 11.667, 92.736], ['Puducherry', 11.913, 79.814], ['Rajkot', 22.303, 70.802],
  ['Chhatrapati Sambhajinagar', 19.876, 75.343], ['Hubballi', 15.364, 75.124],
  ['Mangaluru', 12.914, 74.856], ['Tiruchirappalli', 10.790, 78.704], ['Vijayawada', 16.506, 80.648],
  ['Tirupati', 13.628, 79.419], ['Warangal', 17.978, 79.594], ['Kota', 25.214, 75.864],
  ['Bikaner', 28.022, 73.312], ['Haridwar', 29.946, 78.164], ['Prayagraj', 25.435, 81.846],
  ['Gorakhpur', 26.761, 83.373], ['Jhansi', 25.449, 78.569], ['Ajmer', 26.449, 74.640],
  ['Salem', 11.664, 78.146], ['Vellore', 12.917, 79.132], ['Kozhikode', 11.259, 75.780],
  ['Thrissur', 10.527, 76.214], ['Nellore', 14.443, 79.986], ['Guntur', 16.307, 80.436],
  ['Durgapur', 23.520, 87.312], ['Asansol', 23.685, 86.974], ['Dhanbad', 23.796, 86.430],
  ['Jamshedpur', 22.804, 86.203], ['Cuttack', 20.463, 85.883], ['Rourkela', 22.260, 84.854],
  ['Bilaspur', 22.080, 82.139], ['Ujjain', 23.179, 75.785], ['Meerut', 28.984, 77.706],
  ['Bareilly', 28.367, 79.430], ['Aligarh', 27.897, 78.088], ['Moradabad', 28.839, 78.777],
  ['Solapur', 17.660, 75.906], ['Kolhapur', 16.705, 74.243], ['Belagavi', 15.850, 74.498],
  ['Tirunelveli', 8.713, 77.757], ['Erode', 11.341, 77.717], ['Rajahmundry', 17.000, 81.804],
  ['Kakinada', 16.989, 82.247], ['Anantapur', 14.681, 77.601], ['Kurnool', 15.828, 78.037],
  ['Shivamogga', 13.929, 75.568], ['Davangere', 14.464, 75.921], ['Kollam', 8.893, 76.614],
  ['Kannur', 11.874, 75.370], ['Pathankot', 32.265, 75.652], ['Ambala', 30.378, 76.776],
  ['Rewa', 24.536, 81.304], ['Satna', 24.601, 80.832], ['Korba', 22.345, 82.696],
  ['Muzaffarpur', 26.122, 85.379], ['Gaya', 24.780, 85.000], ['Darbhanga', 26.155, 85.897],
];

export function nearestCity(lat, lng) {
  let best = null, bestD = Infinity;
  for (const [name, clat, clng] of CITIES) {
    const d = (clat - lat) ** 2 + (clng - lng) ** 2;
    if (d < bestD) { bestD = d; best = { name, lat: clat, lng: clng }; }
  }
  // ~0.35° ≈ 38 km — beyond that say "near X"
  return { ...best, near: bestD > 0.12 };
}
