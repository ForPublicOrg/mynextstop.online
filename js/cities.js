// Origin fallback: major Indian cities for "I'll type where I am".
// Destinations from the dataset are merged into this search at runtime.
//
// Coverage: every state/UT capital, every city over ~200k, and the regional
// hubs people actually set out from. Coordinates are city-centre points from
// Wikidata / OpenStreetMap, each reverse-geocoded back to confirm it lands in
// the right town: several were district centroids before. Renamed cities keep
// the old name in brackets so search still finds them (the list is matched by
// substring).
export const CITIES = [
  ['Agartala', 23.832, 91.286], ['Agra', 27.177, 78.008], ['Ahilyanagar (Ahmednagar)', 19.083, 74.733],
  ['Ahmedabad', 23.023, 72.571], ['Aizawl', 23.727, 92.718], ['Ajmer', 26.449, 74.640],
  ['Akola', 20.733, 77.000], ['Alappuzha', 9.492, 76.329], ['Aligarh', 27.897, 78.088],
  ['Alwar', 27.567, 76.617], ['Ambala', 30.378, 76.776], ['Ambikapur', 23.123, 83.198],
  ['Amravati', 20.933, 77.750], ['Amritsar', 31.634, 74.872], ['Anand', 22.559, 72.963],
  ['Anantapur', 14.681, 77.601], ['Anantnag', 33.737, 75.146], ['Arrah (Ara)', 25.563, 84.671],
  ['Asansol', 23.685, 86.974], ['Balasore', 21.502, 86.922], ['Ballari (Bellary)', 15.150, 76.933],
  ['Baramulla', 34.209, 74.343], ['Bardhaman (Burdwan)', 23.250, 87.868], ['Bareilly', 28.367, 79.430],
  ['Barmer', 25.745, 71.400], ['Bathinda', 30.213, 74.952], ['Begusarai', 25.420, 86.130],
  ['Belagavi (Belgaum)', 15.850, 74.498], ['Bengaluru (Bangalore)', 12.972, 77.594], ['Bhagalpur', 25.250, 87.017],
  ['Bharatpur', 27.217, 77.490], ['Bhavnagar', 21.772, 72.142], ['Bhilwara', 25.350, 74.633],
  ['Bhopal', 23.259, 77.413], ['Bhubaneswar', 20.296, 85.824], ['Bidar', 17.917, 77.511],
  ['Bihar Sharif', 25.194, 85.521], ['Bikaner', 28.022, 73.312], ['Bilaspur', 22.080, 82.139],
  ['Bokaro Steel City', 23.654, 86.146], ['Brahmapur (Berhampur)', 19.320, 84.780], ['Chandigarh', 30.733, 76.779],
  ['Chandrapur', 19.951, 79.299], ['Chennai', 13.083, 80.270], ['Chhatrapati Sambhajinagar (Aurangabad)', 19.876, 75.343],
  ['Chhindwara', 22.058, 78.939], ['Chittoor', 13.216, 79.097], ['Coimbatore', 11.017, 76.956],
  ['Cuddalore', 11.756, 79.763], ['Cuttack', 20.463, 85.883], ['Daman', 20.417, 72.833],
  ['Darbhanga', 26.155, 85.897], ['Davangere', 14.464, 75.921], ['Dehradun', 30.317, 78.032],
  ['Delhi', 28.614, 77.209], ['Deoghar', 24.480, 86.700], ['Dhanbad', 23.796, 86.430],
  ['Dhule', 20.901, 74.778], ['Dibrugarh', 27.484, 94.902], ['Dimapur', 25.912, 93.722],
  ['Dindigul', 10.362, 77.974], ['Durg-Bhilai', 21.190, 81.280], ['Durgapur', 23.520, 87.312],
  ['Eluru', 16.712, 81.103], ['Erode', 11.341, 77.717], ['Faridabad', 28.417, 77.300],
  ['Farrukhabad', 27.391, 79.579], ['Firozabad', 27.153, 78.399], ['Gandhinagar', 23.223, 72.650],
  ['Gangtok', 27.339, 88.607], ['Gaya', 24.780, 85.000], ['Ghaziabad', 28.667, 77.417],
  ['Gorakhpur', 26.761, 83.373], ['Guntur', 16.307, 80.436], ['Gurugram (Gurgaon)', 28.996, 79.641],
  ['Guwahati', 26.144, 91.736], ['Gwalior', 26.218, 78.183], ['Haldia', 22.030, 88.060],
  ['Haldwani', 29.214, 79.528], ['Haridwar', 29.946, 78.164], ['Hassan', 13.007, 76.099],
  ['Hazaribagh', 23.992, 85.362], ['Hisar', 29.149, 75.737], ['Hosur', 12.733, 77.831],
  ['Howrah', 22.574, 88.325], ['Hubballi (Hubli)', 15.364, 75.124], ['Hyderabad', 17.385, 78.487],
  ['Imphal', 24.817, 93.937], ['Indore', 22.720, 75.858], ['Itanagar', 27.084, 93.605],
  ['Jabalpur', 23.182, 79.986], ['Jagdalpur', 19.087, 82.024], ['Jaipur', 26.912, 75.787],
  ['Jalandhar', 31.326, 75.579], ['Jalgaon', 21.017, 75.567], ['Jalna', 19.833, 75.883],
  ['Jalpaiguri', 26.524, 88.720], ['Jammu', 32.727, 74.857], ['Jamnagar', 22.470, 70.070],
  ['Jamshedpur', 22.804, 86.203], ['Jaunpur', 25.747, 82.689], ['Jhansi', 25.449, 78.569],
  ['Jodhpur', 26.238, 73.024], ['Jorhat', 26.758, 94.208], ['Junagadh', 21.520, 70.470],
  ['Kadapa', 14.467, 78.817], ['Kakinada', 16.989, 82.247], ['Kalaburagi (Gulbarga)', 17.331, 76.833],
  ['Kalyan-Dombivli', 19.233, 73.133], ['Kanchipuram', 12.836, 79.705], ['Kannur', 11.874, 75.370],
  ['Kanpur', 26.449, 80.331], ['Kargil', 34.559, 76.126], ['Karimnagar', 18.436, 79.134],
  ['Karnal', 29.680, 76.990], ['Karur', 10.960, 78.081], ['Kashipur', 29.212, 78.962],
  ['Katni', 23.837, 80.394], ['Kavaratti', 10.567, 72.639], ['Khammam', 17.247, 80.150],
  ['Kharagpur', 22.330, 87.324], ['Kochi (Cochin)', 9.932, 76.267], ['Kohima', 25.675, 94.110],
  ['Kolhapur', 16.705, 74.243], ['Kolkata', 22.573, 88.364], ['Kollam', 8.893, 76.614],
  ['Korba', 22.345, 82.696], ['Kota', 25.214, 75.864], ['Kottayam', 9.592, 76.522],
  ['Kozhikode (Calicut)', 11.259, 75.780], ['Krishnanagar', 23.406, 88.496], ['Kullu', 31.958, 77.109],
  ['Kurnool', 15.828, 78.037], ['Latur', 18.397, 76.568], ['Leh', 34.152, 77.577],
  ['Lucknow', 26.847, 80.946], ['Ludhiana', 30.901, 75.857], ['Madurai', 9.925, 78.120],
  ['Mahbubnagar', 16.743, 77.992], ['Malappuram', 11.043, 76.081], ['Malda', 25.004, 88.146],
  ['Malegaon', 20.550, 74.535], ['Mandi', 31.708, 76.929], ['Mangaluru (Mangalore)', 12.914, 74.856],
  ['Mathura', 27.496, 77.686], ['Meerut', 28.984, 77.706], ['Mirzapur', 25.146, 82.569],
  ['Moradabad', 28.839, 78.777], ['Mumbai', 19.076, 72.877], ['Munger', 25.381, 86.465],
  ['Muzaffarnagar', 29.471, 77.703], ['Muzaffarpur', 26.122, 85.379], ['Mysuru (Mysore)', 12.296, 76.639],
  ['Nadiad', 22.700, 72.870], ['Nagaon', 26.348, 92.686], ['Nagercoil', 8.184, 77.432],
  ['Nagpur', 21.146, 79.088], ['Namchi', 27.166, 88.365], ['Nanded', 21.143, 75.269],
  ['Nandyal', 15.480, 78.480], ['Nashik', 19.997, 73.790], ['Navi Mumbai', 19.030, 73.010],
  ['Nellore', 14.443, 79.986], ['Nizamabad', 18.672, 78.094], ['Noida', 28.570, 77.320],
  ['Ongole', 15.500, 80.050], ['Palakkad', 10.768, 76.652], ['Pali', 25.773, 73.323],
  ['Panaji (Goa)', 15.499, 73.827], ['Panipat', 29.391, 76.977], ['Pasighat', 28.059, 95.332],
  ['Pathankot', 32.265, 75.652], ['Patna', 25.594, 85.138], ['Port Blair', 11.667, 92.736],
  ['Prayagraj (Allahabad)', 25.435, 81.846], ['Puducherry (Pondicherry)', 11.913, 79.814], ['Pune', 18.520, 73.857],
  ['Puri', 19.800, 85.817], ['Purnia', 25.780, 87.470], ['Raichur', 16.198, 77.353],
  ['Raipur', 21.251, 81.630], ['Rajahmundry', 17.000, 81.804], ['Rajkot', 22.303, 70.802],
  ['Ramagundam', 18.800, 79.450], ['Ranchi', 23.344, 85.310], ['Ratlam', 23.317, 75.067],
  ['Ratnagiri', 16.993, 73.295], ['Rewa', 24.536, 81.304], ['Rohtak', 28.900, 76.567],
  ['Roorkee', 29.869, 77.890], ['Rourkela', 22.260, 84.854], ['Rudrapur', 28.971, 79.397],
  ['Sagar', 23.842, 78.747], ['Saharanpur', 29.964, 77.546], ['Salem', 11.664, 78.146],
  ['Sambalpur', 21.471, 83.976], ['Sangli', 16.867, 74.567], ['Satara', 17.688, 74.004],
  ['Satna', 24.601, 80.832], ['Shillong', 25.579, 91.893], ['Shimla', 31.104, 77.173],
  ['Shivamogga (Shimoga)', 13.929, 75.568], ['Sikar', 27.609, 75.140], ['Silchar', 24.817, 92.800],
  ['Siliguri', 26.727, 88.395], ['Silvassa', 20.274, 73.005], ['Solan', 30.908, 77.102],
  ['Solapur', 17.660, 75.906], ['Sri Ganganagar', 29.917, 73.883], ['Srikakulam', 18.295, 83.894],
  ['Srinagar', 34.084, 74.797], ['Sultanpur', 26.259, 82.072], ['Surat', 21.170, 72.831],
  ['Tezpur', 26.623, 92.798], ['Thane', 19.180, 72.963], ['Thanjavur', 10.787, 79.138],
  ['Thiruvananthapuram (Trivandrum)', 8.524, 76.936], ['Thoothukudi', 8.805, 78.145], ['Thrissur', 10.527, 76.214],
  ['Tinsukia', 27.488, 95.360], ['Tiruchirappalli (Trichy)', 10.790, 78.704], ['Tirunelveli', 8.713, 77.757],
  ['Tirupati', 13.628, 79.419], ['Tumakuru', 13.340, 77.101], ['Tura', 25.513, 90.217],
  ['Udaipur', 24.585, 73.712], ['Udhampur', 32.922, 75.133], ['Udupi', 13.342, 74.747],
  ['Ujjain', 23.179, 75.785], ['Vadodara (Baroda)', 22.307, 73.181], ['Varanasi (Banaras)', 25.317, 82.973],
  ['Vasai-Virar', 19.470, 72.800], ['Vellore', 12.917, 79.132], ['Vijayapura (Bijapur)', 16.824, 75.715],
  ['Vijayawada', 16.506, 80.648], ['Visakhapatnam (Vizag)', 17.687, 83.219], ['Vizianagaram', 18.117, 83.417],
  ['Warangal', 17.978, 79.594],
];

export function nearestCity(lat, lng) {
  let best = null, bestD = Infinity;
  for (const [name, clat, clng] of CITIES) {
    const d = (clat - lat) ** 2 + (clng - lng) ** 2;
    if (d < bestD) { bestD = d; best = { name, lat: clat, lng: clng }; }
  }
  // ~0.35° ≈ 38 km: beyond that say "near X"
  return { ...best, near: bestD > 0.12 };
}
