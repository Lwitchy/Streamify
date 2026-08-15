document.addEventListener("DOMContentLoaded", () => {
  // 1. Grab all elements with the matching class
  const divs = document.querySelectorAll('.random-content');
  
  if (divs.length > 0) {
    // 2. Generate a random index between 0 and the total number of divs
    const randomIndex = Math.floor(Math.random() * divs.length);
    
    // Only fetch the artwork that will actually be displayed.
    const selected = divs[randomIndex];
    const image = selected.querySelector('img[data-src]');
    if (image) image.src = image.dataset.src;
    selected.style.display = 'block';
  }

  // Click on About button to show toast
  const aboutButton = document.getElementById('about-link-admin');
  if (aboutButton) {
    aboutButton.addEventListener('click', () => {
      alert("You're trying to access the admin panel, which is forbidden. Please go back to the Homepage. ^_^ ");
    });
  }

});
