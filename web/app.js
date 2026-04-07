async function addProfile() {
  await fetch("/api/profile", { method: "POST" });
}

async function load() {
  const profiles = await fetch("/api/profiles").then(r => r.json());

  const container = document.getElementById("profileCheckboxes");
  container.innerHTML = "";

  profiles.forEach(p => {
    container.innerHTML += `
      <label>
        <input type="checkbox" value="${p.id}">
        ${p.id}
      </label><br>
    `;
  });

  const posts = await fetch("/api/posts").then(r => r.json());
  document.getElementById("posts").textContent = JSON.stringify(posts, null, 2);
}

async function submitPost() {
  const file = document.getElementById("file").files[0];

  const fd = new FormData();
  fd.append("file", file);

  const upload = await fetch("/api/upload", {
    method: "POST",
    body: fd
  });

  const { path } = await upload.json();

  const selected = [...document.querySelectorAll("input[type=checkbox]:checked")]
    .map(el => el.value);

  await fetch("/api/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      caption: document.getElementById("caption").value,
      image: path,
      time: new Date(document.getElementById("time").value).getTime(),
      profiles: selected
    })
  });

  alert("Scheduled");
  load();
}

setInterval(load, 5000);
load();
