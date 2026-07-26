import { supabase } from "../../assets/js/supabase-config.js";
// const supabase = createClient(supabaseUrl, supabaseAnonKey); // Removed duplicate
// fetch("/.netlify/functions/supabase")
//   .then(response => response.json())
//   .then(config => {
//     const supabaseUrl = config.supabaseUrl;
//     const supabaseAnonKey = config.supabaseAnonKey;

//     // console.log("Supabase URL:", supabaseUrl);
//     // console.log("Supabase Anon Key:", supabaseAnonKey);

//     // Now you can initialize Supabase
//     const supabase = createClient(supabaseUrl, supabaseAnonKey);
    
//   }).catch(error => console.error("Error fetching keys:", error));
  document.addEventListener('DOMContentLoaded', function() {
    const password = document.getElementById('password');
    const togglePassword = document.getElementById('toggle-password');
    togglePassword.addEventListener('click', function (){
      if(password.type === 'password'){
          password.type = 'text';
          document.getElementById('toggle-password').innerHTML = '<i class="bi bi-eye"></i>';
      }else{
          password.type = 'password';
          document.getElementById('toggle-password').innerHTML = '<i class="bi bi-eye-slash"></i>';
      }
    });
    document.addEventListener('submit', async function(e) {
        e.preventDefault();
        // console.log("yes")
        const studentEmail = document.getElementById('email').value.trim();
        const pass_value = password.value.trim();
        // console.log(pass_value)
        const loginStudent = async (email, password) => {
            // Show loading
            Swal.fire({
                title: 'Signing In...',
                allowOutsideClick: false,
                didOpen: () => {
                    Swal.showLoading()
                }
            });

            const { data, error } = await supabase.auth.signInWithPassword({
              email: email,
              password: password,
            });

            if (error) {
                Swal.fire({
                  title: "Login Failed",
                  text: error.message || "Invalid credentials. Please signup before attempting to sign in.",
                  icon: "error",
                  confirmButtonText: "Okay",
                });
                return;
            }

            const user = data.user;
  
            // Check if student exists and is approved in database
            const { data: student, error: checkError } = await supabase
                .from("students")
                .select("*")
                .eq("user_id", user.id)
                .single();
  
            if (checkError) {
                await supabase.auth.signOut();
                if (checkError.code === "PGRST116") {
                    Swal.fire({
                        title: "Profile Not Found",
                        text: "Your account exists in Auth but not in our records. Please contact admin.",
                        icon: "error",
                        confirmButtonText: "Okay",
                    });
                } else {
                    Swal.fire({
                        title: "Error!",
                        text: "An error occurred while checking your status.",
                        icon: "error",
                        confirmButtonText: "Okay",
                    });
                }
                return;
            }
  
            // Check if student is approved
            if (student.status === 'pending') {
                await supabase.auth.signOut();
                Swal.fire({
                    title: "Account Pending",
                    text: "Your account is still pending admin approval. Please check back later.",
                    icon: "info",
                    confirmButtonText: "Okay",
                });
                return;
            }

            if (student.status === 'rejected') {
                await supabase.auth.signOut();
                Swal.fire({
                    title: "Access Denied",
                    text: "Your account has been rejected by the admin. Please contact support.",
                    icon: "error",
                    confirmButtonText: "Okay",
                });
                return;
            }

            if (student.status !== 'approved') {
                await supabase.auth.signOut();
                Swal.fire({
                    title: "Access Denied",
                    text: "Your account is not approved.",
                    icon: "warning",
                    confirmButtonText: "Okay",
                });
                return;
            }
  
            // Success - Redirect to dashboard
            Swal.fire({
                title: "Welcome Back!",
                text: `Success! Welcome, ${student.first_name}.`,
                icon: "success",
                timer: 2000,
                showConfirmButton: false
            }).then(() => {
                window.location.href = "student-dashboard.html";
            });
        }
        loginStudent(studentEmail.toLowerCase(), pass_value)
    });
});
  


// document.addEventListener("DOMContentLoaded", function () {
//   document.getElementById("login-form").addEventListener("submit", async function (e) {
//     e.preventDefault();

//     const studentEmail = document.getElementById("email").value.trim();
//     const password = document.getElementById("password").value.trim();

//     if (!studentEmail || !password) {
//       Swal.fire({
//         title: "Missing Fields",
//         text: "Please enter both email and password.",
//         icon: "warning",
//         confirmButtonText: "Okay",
//       });
//       return;
//     }

//     try {
//       const response = await fetch("/.netlify/functions/signIn", {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({ email: studentEmail, password }),
//       });

//       const result = await response.json();

//       if (!response.ok) {
//         Swal.fire({
//           title: "Error!",
//           text: result.error || "Login failed",
//           icon: "error",
//           confirmButtonText: "Okay",
//         });
//         return;
//       }

//       Swal.fire({
//         title: "Success!",
//         text: "Login successful. Redirecting...",
//         icon: "success",
//         confirmButtonText: "Okay",
//       }).then(() => {
//         window.location.href = "student-dashboard.html";
//       });
//     } catch (error) {
//       console.error("Login error:", error);
//       Swal.fire({
//         title: "Error!",
//         text: "An unexpected error occurred",
//         icon: "error",
//         confirmButtonText: "Okay",
//       });
//     }
//   });
// });

  